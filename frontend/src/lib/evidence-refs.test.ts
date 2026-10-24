import { describe, expect, it, vi } from "vitest";
import type { EvidenceSummary } from "../api/types";
import {
  EVIDENCE_CONCURRENCY,
  extractEvidenceRefs,
  groupTaskEvidence,
  hasReasoningExcerpt,
  loadTaskEvidence,
  MAX_TASK_EVIDENCE,
  resolveEvidenceRefs,
} from "./evidence-refs";

const taskId = "task_evidence_test";
const id = (number: number) =>
  `evidence_${number.toString(16).padStart(24, "0")}`;
const record = (
  evidenceId: string,
  overrides: Partial<EvidenceSummary> = {},
): EvidenceSummary => ({
  schemaVersion: "0.1.0",
  evidenceId,
  taskId,
  sourceKind: "MODEL_OUTPUT",
  trust: "MODEL_DERIVED",
  parentIds: [],
  parentClosureHash: `sha256:${"1".repeat(64)}`,
  contentHash: `sha256:${"2".repeat(64)}`,
  excerpt: "公开的最终输出。",
  recordedAt: "2026-10-24T08:00:00Z",
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe("public evidence references", () => {
  it("reads explicit legacy references only from the current task's summaries", () => {
    expect(extractEvidenceRefs(
      { taskId, summary: `资料 ${id(1)}，模型 ${id(2)}，再次 ${id(1)}` },
      [
        { taskId, summary: `主机记录 ${id(3)}` },
        { taskId: "task_other", summary: id(4) },
      ],
    )).toEqual([id(1), id(2), id(3)]);
  });

  it("does not guess malformed references or truncate a larger token", () => {
    const short = `evidence_${"a".repeat(23)}`;
    const long = `evidence_${"a".repeat(33)}`;
    const valid32 = `evidence_${"b".repeat(32)}`;
    expect(extractEvidenceRefs(
      { taskId, summary: `${short} ${long} prefix_${id(1)} ${id(2)}suffix ${valid32}` },
      [],
    )).toEqual([valid32]);
    expect(extractEvidenceRefs({ taskId, summary: null }, [])).toEqual([]);
  });

  it("uses structured IDs exclusively, including an empty list", () => {
    const task = { taskId, summary: id(1) };
    expect(resolveEvidenceRefs(task, [], [])).toEqual([]);
    expect(resolveEvidenceRefs(task, [], ["evidence_structured", id(2), id(2), "../other"])).toEqual([
      "evidence_structured", id(2),
    ]);
    expect(resolveEvidenceRefs(task, [])).toEqual([id(1)]);
  });
});

describe("bounded public evidence traversal", () => {
  it("follows parents, preserves fields, and terminates on a cyclic or repeated parent", async () => {
    const root = record(id(1), { parentIds: [id(2), id(2), "../unsafe"] });
    const parent = record(id(2), {
      parentIds: [id(1)],
      sourceKind: "TOOL_RESPONSE",
      trust: "EXTERNAL_UNTRUSTED",
      excerpt: "<script>untrusted()</script>",
    });
    const client = {
      evidence: vi.fn(async (_task: string, evidenceId: string) =>
        evidenceId === id(1) ? root : parent),
    };
    const result = await loadTaskEvidence(client, taskId, [id(1), id(1)]);
    expect(client.evidence.mock.calls).toEqual([[taskId, id(1)], [taskId, id(2)]]);
    expect(result.records).toEqual([root, parent]);
    expect(result.skippedParentIds).toEqual(["../unsafe"]);
    expect(result.failures).toEqual([]);
    expect(result.cancelled).toBe(false);
  });

  it("caps the whole parent chain at 20 GETs without dropping direct references first", async () => {
    const references = [id(1), id(2), id(3)];
    const client = {
      evidence: vi.fn(async (_task: string, evidenceId: string) => record(evidenceId, {
        parentIds: Array.from({ length: 40 }, (_, index) => id(index + 4)),
      })),
    };
    const result = await loadTaskEvidence(client, taskId, references);
    expect(client.evidence).toHaveBeenCalledTimes(MAX_TASK_EVIDENCE);
    expect(result.requestedIds.slice(0, 3)).toEqual(references);
    expect(new Set(result.requestedIds).size).toBe(MAX_TASK_EVIDENCE);
    expect(result.truncated).toBe(true);
  });

  it("uses at most three concurrent GETs even when one root discovers many parents", async () => {
    const parentIds = [id(2), id(3), id(4), id(5), id(6), id(7)];
    const pending = new Map<string, ReturnType<typeof deferred<EvidenceSummary>>>();
    let active = 0;
    let peak = 0;
    const client = {
      evidence: vi.fn(async (_task: string, evidenceId: string) => {
        if (evidenceId === id(1)) return record(evidenceId, { parentIds });
        ++active;
        peak = Math.max(peak, active);
        const request = deferred<EvidenceSummary>();
        pending.set(evidenceId, request);
        return request.promise.finally(() => { --active; });
      }),
    };
    const completion = loadTaskEvidence(client, taskId, [id(1)]);
    await vi.waitFor(() => expect(pending.size).toBe(EVIDENCE_CONCURRENCY));
    expect(active).toBe(3);
    for (const [evidenceId, request] of pending) request.resolve(record(evidenceId));
    await vi.waitFor(() => expect(pending.size).toBe(parentIds.length));
    for (const [evidenceId, request] of pending) request.resolve(record(evidenceId));
    const result = await completion;
    expect(peak).toBe(EVIDENCE_CONCURRENCY);
    expect(result.records).toHaveLength(7);
  });

  it.each([
    { taskId: "task_other" },
    { evidenceId: id(9) },
  ])("rejects a response with a mismatched owner or identity: %j", async (overrides) => {
    const client = {
      evidence: vi.fn(async () => record(id(1), { ...overrides, parentIds: [id(2)] })),
    };
    const result = await loadTaskEvidence(client, taskId, [id(1)]);
    expect(client.evidence).toHaveBeenCalledTimes(1);
    expect(result.records).toEqual([]);
    expect(result.failures).toEqual([{
      evidenceId: id(1), message: "证据与当前任务或引用不一致，已忽略。",
    }]);
  });

  it("keeps partial successes and allows a failed GET to be retried explicitly", async () => {
    const client = {
      evidence: vi.fn()
        .mockRejectedValueOnce(new Error("暂时不可用"))
        .mockResolvedValueOnce(record(id(2)))
        .mockResolvedValueOnce(record(id(1))),
    };
    const first = await loadTaskEvidence(client, taskId, [id(1), id(2)]);
    expect(first.records.map((item) => item.evidenceId)).toEqual([id(2)]);
    expect(first.failures).toEqual([{ evidenceId: id(1), message: "暂时不可用" }]);
    const retry = await loadTaskEvidence(client, taskId, [id(1)]);
    expect(retry.records.map((item) => item.evidenceId)).toEqual([id(1)]);
    expect(retry.failures).toEqual([]);
  });

  it("stops queued reads and late updates after a client or task is superseded", async () => {
    let current = true;
    const pending: Array<ReturnType<typeof deferred<EvidenceSummary>>> = [];
    const progress = vi.fn();
    const client = {
      evidence: vi.fn(() => {
        const request = deferred<EvidenceSummary>();
        pending.push(request);
        return request.promise;
      }),
    };
    const completion = loadTaskEvidence(
      client,
      taskId,
      Array.from({ length: 10 }, (_, index) => id(index + 1)),
      { isCurrent: () => current, onProgress: progress },
    );
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    current = false;
    pending.forEach((request, index) => request.resolve(record(id(index + 1))));
    const result = await completion;
    expect(client.evidence).toHaveBeenCalledTimes(3);
    expect(progress).not.toHaveBeenCalled();
    expect(result.records).toEqual([]);
    expect(result.cancelled).toBe(true);
  });
});

describe("evidence presentation policy", () => {
  it("prioritizes model, tool, and host records while keeping supporting originals intact", () => {
    const records = [
      record(id(1), { sourceKind: "TRUSTED_CATALOG" }),
      record(id(2), { sourceKind: "HOST_CHECK" }),
      record(id(3), { sourceKind: "MODEL_OUTPUT" }),
      record(id(4), { sourceKind: "USER_INPUT" }),
      record(id(5), { sourceKind: "TOOL_RESPONSE" }),
    ];
    const groups = groupTaskEvidence(records);
    expect(groups.primary.map((item) => item.evidenceId)).toEqual([id(3), id(5), id(2)]);
    expect(groups.supporting.map((item) => item.evidenceId)).toEqual([id(4), id(1)]);
    expect(records.map((item) => item.evidenceId)).toEqual([id(1), id(2), id(3), id(4), id(5)]);
  });

  it("withholds explicitly marked model reasoning without rewriting public source excerpts", () => {
    expect(hasReasoningExcerpt(record(id(1), { excerpt: "<think>private</think>final" }))).toBe(true);
    expect(hasReasoningExcerpt(record(id(1), { excerpt: "&lt;analysis&gt;private" }))).toBe(true);
    expect(hasReasoningExcerpt(record(id(1), { excerpt: "最终结论与可核对的来源。" }))).toBe(false);
    expect(hasReasoningExcerpt(record(id(1), { sourceKind: "TOOL_RESPONSE", excerpt: "<analysis>public source</analysis>" }))).toBe(false);
  });
});
