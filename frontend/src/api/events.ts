import { ApiError, MotionClient, validatePublicView } from "./client";
import type { EventEnvelope, TaskSnapshot } from "./types";

export type EventConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed"
  | "error";
export interface TaskEventHandlers {
  onEvent: (event: EventEnvelope) => void | Promise<void>;
  onResync: (snapshot: TaskSnapshot) => void | Promise<void>;
  onStatus?: (status: EventConnectionStatus) => void;
}

export interface SseFrame {
  id: string;
  event: string;
  data: string;
}

/** SSE lines and frames may span any number of fetch chunks, including between CR and LF. */
export class SseParser {
  #buffer = "";
  #id = "";
  #event = "";
  #data: string[] = [];
  #frameLength = 0;
  #firstChunk = true;

  push(text: string): SseFrame[] {
    if (this.#firstChunk && text.length > 0) {
      text = text.replace(/^\uFEFF/, "");
      this.#firstChunk = false;
    }
    this.#buffer += text;
    if (this.#buffer.length + this.#frameLength > 1_048_576)
      throw streamError("事件帧超过允许大小。");
    const frames: SseFrame[] = [];
    while (true) {
      const match = /[\r\n]/.exec(this.#buffer);
      if (!match) break;
      const index = match.index;
      if (this.#buffer[index] === "\r" && index === this.#buffer.length - 1)
        break;
      const line = this.#buffer.slice(0, index);
      const size =
        this.#buffer[index] === "\r" && this.#buffer[index + 1] === "\n"
          ? 2
          : 1;
      this.#buffer = this.#buffer.slice(index + size);
      this.#frameLength += line.length;
      if (!line) {
        if (this.#data.length)
          frames.push({
            id: this.#id,
            event: this.#event || "message",
            data: this.#data.join("\n"),
          });
        this.#id = "";
        this.#event = "";
        this.#data = [];
        this.#frameLength = 0;
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this.#data.push(value);
      if (field === "event") this.#event = value;
      if (field === "id" && !value.includes("\0")) this.#id = value;
      // Server retry fields cannot override the client's bounded reconnect policy.
    }
    return frames;
  }

  /** At EOF a trailing CR is itself a valid line terminator; an unfinished frame is discarded. */
  finish(): SseFrame[] {
    return this.#buffer.endsWith("\r") ? this.push("\n") : [];
  }
}

function streamError(message: string): ApiError {
  return new ApiError(0, "INVALID_EVENT_STREAM", "client_events", message);
}

function retryable(error: unknown): boolean {
  return (
    !(error instanceof ApiError) ||
    error.code === "EVENT_STREAM_ENDED" ||
    error.status === 429 ||
    error.status >= 500
  );
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Read a fetch SSE stream with an in-memory bearer, exact cursor recovery and at most
 * four reconnects. The caller obtains the initial lastSeq from a GET TaskSnapshot.
 * Aborting closes the stream; it never calls task cancel/revoke.
 */
export async function subscribeTaskEvents(
  client: MotionClient,
  taskId: string,
  lastSeq: number,
  handlers: TaskEventHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = lastSeq;
  let reconnects = 0;
  const maxReconnects = 4;
  const resync = async (): Promise<void> => {
    const snapshot = await client.task(taskId, signal);
    if (snapshot.taskId !== taskId || snapshot.lastEventSeq < cursor)
      throw streamError("恢复快照的任务或事件游标不匹配。");
    await handlers.onResync(snapshot);
    cursor = snapshot.lastEventSeq;
  };

  try {
    while (!signal?.aborted) {
      handlers.onStatus?.(reconnects ? "reconnecting" : "connecting");
      try {
        const response = await client.openEventStream(taskId, cursor, signal);
        const mode = response.headers.get("X-Execution-Mode");
        const reader = response.body!.getReader();
        const abortReader = () => {
          void reader.cancel().catch(() => undefined);
        };
        signal?.addEventListener("abort", abortReader, { once: true });
        handlers.onStatus?.("connected");
        const decoder = new TextDecoder();
        const parser = new SseParser();
        try {
          while (!signal?.aborted) {
            const { done, value } = await reader.read();
            const frames = done
              ? [...parser.push(decoder.decode()), ...parser.finish()]
              : parser.push(decoder.decode(value, { stream: true }));
            for (const frame of frames) {
              let payload: unknown;
              try {
                payload = JSON.parse(frame.data);
              } catch {
                throw streamError("事件包含无效 JSON。");
              }
              const event = validatePublicView("EventEnvelope", payload);
              if (
                event.taskId !== taskId ||
                event.executionMode !== mode ||
                event.eventId !== `${taskId}:${event.seq}` ||
                frame.id !== event.eventId ||
                frame.event !== event.type
              ) {
                throw streamError("事件身份、类型、游标或执行模式不一致。");
              }
              if (event.seq <= cursor) continue;
              if (event.seq !== cursor + 1) await resync();
              if (event.seq <= cursor) continue;
              if (event.seq !== cursor + 1)
                throw streamError("事件序号存在未恢复的缺口。");
              if (signal?.aborted) break;
              await handlers.onEvent(event);
              cursor = event.seq;
            }
            if (done) break;
          }
        } finally {
          signal?.removeEventListener("abort", abortReader);
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        if (signal?.aborted) break;
        throw new ApiError(
          0,
          "EVENT_STREAM_ENDED",
          "client_events",
          "事件连接已断开。",
        );
      } catch (error) {
        if (signal?.aborted) break;
        if (
          error instanceof ApiError &&
          error.status === 410 &&
          error.code === "EVENT_CURSOR_EXPIRED"
        ) {
          if (reconnects >= maxReconnects) throw error;
          reconnects++;
          await resync();
          continue;
        }
        if (!retryable(error) || reconnects >= maxReconnects) throw error;
        reconnects++;
        handlers.onStatus?.("reconnecting");
        await delay(Math.min(500 * 2 ** (reconnects - 1), 4000), signal);
      }
    }
    handlers.onStatus?.("closed");
  } catch (error) {
    if (signal?.aborted) {
      handlers.onStatus?.("closed");
      return;
    }
    handlers.onStatus?.("error");
    throw error;
  }
}
