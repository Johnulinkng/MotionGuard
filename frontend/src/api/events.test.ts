import { afterEach, describe, expect, it, vi } from "vitest";
import task from "../../vendor/contract/fixtures/normal-task.json";
import { MotionClient } from "./client";
import { SseParser, subscribeTaskEvents } from "./events";
import type { EventEnvelope } from "./types";

function event(seq: number): EventEnvelope {
  return {
    schemaVersion: "0.1.0",
    eventId: `task_demo:${seq}`,
    taskId: "task_demo",
    seq,
    type: "task.updated",
    occurredAt: "2026-10-24T06:00:00.000Z",
    aggregateVersion: seq,
    executionMode: "MOCK",
    summary: "模拟任务更新",
    resourceId: "task_demo",
    resourceType: "TASK",
  };
}
function frame(value: EventEnvelope): string {
  return `id: ${value.eventId}\r\nevent: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
}
function stream(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "X-Contract-Version": "0.2.0",
        "X-Execution-Mode": "MOCK",
      },
    },
  );
}
function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Contract-Version": "0.2.0",
      "X-Execution-Mode": "MOCK",
      ETag: task.etag,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SSE parser", () => {
  it("handles split CRLF, comment heartbeats and multiple data lines", () => {
    const parser = new SseParser();
    expect(parser.push("\uFEFF: heartbeat\r")).toEqual([]);
    expect(
      parser.push(
        '\n\r\nid: task_demo:1\r\nevent: task.updated\r\ndata: {"value":\r',
      ),
    ).toEqual([]);
    expect(parser.push("\ndata: 1}\r\n\r")).toEqual([]);
    expect(parser.push("\n")).toEqual([
      { id: "task_demo:1", event: "task.updated", data: '{"value":\n1}' },
    ]);
    expect(parser.push(": another heartbeat\n\n")).toEqual([]);
  });

  it("keeps incomplete frames undispatched and caps buffered frame size", () => {
    const parser = new SseParser();
    expect(parser.push('id: task_demo:1\ndata: {"incomplete":true}\n')).toEqual(
      [],
    );
    expect(() => parser.push("x".repeat(1_048_577))).toThrow(
      "事件帧超过允许大小",
    );
  });

  it("accepts lone CR frame delimiters at EOF without dispatching an unfinished data line", () => {
    const parser = new SseParser();
    expect(
      parser.push("id: task_demo:1\revent: task.updated\rdata: {}\r\r"),
    ).toEqual([]);
    expect(parser.finish()).toEqual([
      { id: "task_demo:1", event: "task.updated", data: "{}" },
    ]);
    const incomplete = new SseParser();
    incomplete.push("data: {}");
    expect(incomplete.finish()).toEqual([]);
  });
});

describe("fetch task event subscription", () => {
  it("decodes split UTF-8 chunks, deduplicates sequences and closes on Abort without cancel mutation", async () => {
    const bytes = new TextEncoder().encode(
      `: ping\r\n\r\n${frame(event(1))}${frame(event(1))}${frame(event(2))}`,
    );
    const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
    const fetcher = vi.fn().mockResolvedValue(stream(chunks));
    vi.stubGlobal("fetch", fetcher);
    const abort = new AbortController();
    const received: number[] = [];
    const statuses: string[] = [];
    await subscribeTaskEvents(
      new MotionClient({ token: "memory-only" }),
      "task_demo",
      0,
      {
        onEvent(value) {
          received.push(value.seq);
          if (value.seq === 2) abort.abort();
        },
        onResync: vi.fn(),
        onStatus(status) {
          statuses.push(status);
        },
      },
      abort.signal,
    );
    expect(received).toEqual([1, 2]);
    expect(statuses).toEqual(["connecting", "connected", "closed"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/v1/tasks/task_demo/events");
    expect(init.headers.get("Authorization")).toBe("Bearer memory-only");
    expect(init.headers.get("X-Contract-Version")).toBe("0.2.0");
    expect(init.headers.get("Last-Event-ID")).toBe("task_demo:0");
    expect(init.headers.get("Accept")).toBe("text/event-stream");
  });

  it("recovers a 410 through an authoritative snapshot then reconnects from its cursor", async () => {
    const snapshot = { ...task, lastEventSeq: 7 };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            schemaVersion: "0.1.0",
            error: {
              code: "EVENT_CURSOR_EXPIRED",
              message: "游标已过期",
              requestId: "request_cursor",
              details: {
                minEventSeq: 5,
                snapshotPath: "/api/v1/tasks/task_demo",
              },
            },
          },
          410,
        ),
      )
      .mockResolvedValueOnce(json(snapshot))
      .mockResolvedValueOnce(
        stream([new TextEncoder().encode(frame(event(8)))]),
      );
    vi.stubGlobal("fetch", fetcher);
    const abort = new AbortController();
    const resync = vi.fn();
    const received: number[] = [];
    await subscribeTaskEvents(
      new MotionClient(),
      "task_demo",
      2,
      {
        onEvent(value) {
          received.push(value.seq);
          abort.abort();
        },
        onResync: resync,
      },
      abort.signal,
    );
    expect(resync).toHaveBeenCalledWith(snapshot);
    expect(received).toEqual([8]);
    expect(fetcher.mock.calls[0][1].headers.get("Last-Event-ID")).toBe(
      "task_demo:2",
    );
    expect(fetcher.mock.calls[1][0]).toBe("/api/v1/tasks/task_demo");
    expect(fetcher.mock.calls[2][1].headers.get("Last-Event-ID")).toBe(
      "task_demo:7",
    );
  });

  it("resyncs a sequence gap before dispatching the next event", async () => {
    const snapshot = { ...task, lastEventSeq: 7 };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        stream([new TextEncoder().encode(frame(event(8)))]),
      )
      .mockResolvedValueOnce(json(snapshot));
    vi.stubGlobal("fetch", fetcher);
    const abort = new AbortController();
    const order: string[] = [];
    await subscribeTaskEvents(
      new MotionClient(),
      "task_demo",
      2,
      {
        onResync() {
          order.push("snapshot");
        },
        onEvent() {
          order.push("event");
          abort.abort();
        },
      },
      abort.signal,
    );
    expect(order).toEqual(["snapshot", "event"]);
  });

  it("rejects event ID mismatches without silently retrying malformed data", async () => {
    const invalid = frame(event(1)).replace(
      "id: task_demo:1",
      "id: other_task:1",
    );
    const fetcher = vi
      .fn()
      .mockResolvedValue(stream([new TextEncoder().encode(invalid)]));
    vi.stubGlobal("fetch", fetcher);
    const onEvent = vi.fn();
    await expect(
      subscribeTaskEvents(new MotionClient(), "task_demo", 0, {
        onEvent,
        onResync: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_EVENT_STREAM" });
    expect(onEvent).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects an SSE response that changes an already verified execution mode", async () => {
    const response = stream([]);
    response.headers.set("X-Execution-Mode", "TESTNET");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(task))
      .mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetcher);
    const client = new MotionClient();
    await client.task("task_demo");
    await expect(
      subscribeTaskEvents(client, "task_demo", task.lastEventSeq, {
        onEvent: vi.fn(),
        onResync: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_MODE_CHANGED" });
    expect(client.executionMode).toBe("MOCK");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bounds network retries instead of reconnecting forever", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetcher);
    const statuses: string[] = [];
    const promise = subscribeTaskEvents(new MotionClient(), "task_demo", 0, {
      onEvent: vi.fn(),
      onResync: vi.fn(),
      onStatus(value) {
        statuses.push(value);
      },
    });
    const assertion = expect(promise).rejects.toThrow("offline");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(statuses.at(-1)).toBe("error");
  });

  it("unblocks a pending reader when the caller aborts", async () => {
    const fetcher = vi.fn().mockResolvedValue(stream([]));
    vi.stubGlobal("fetch", fetcher);
    const abort = new AbortController();
    const promise = subscribeTaskEvents(
      new MotionClient(),
      "task_demo",
      0,
      {
        onEvent: vi.fn(),
        onResync: vi.fn(),
        onStatus(value) {
          if (value === "connected") abort.abort();
        },
      },
      abort.signal,
    );
    await expect(promise).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
