import type { MotionClient } from "../api/client";
import type {
  EvidenceSummary,
  EventEnvelope,
  TaskSnapshot,
} from "../api/types";

export const MAX_TASK_EVIDENCE = 20;
export const EVIDENCE_CONCURRENCY = 3;

// Published EvidenceId format. Legacy prose parsing below is deliberately narrower.
const evidenceId = /^[A-Za-z][A-Za-z0-9_-]{2,63}$/;
const evidenceReferences = /\bevidence_[a-fA-F0-9]{24,32}\b/g;

/** Read only explicit public references, never unrelated event/resource fields. */
export function extractEvidenceRefs(
  task: Pick<TaskSnapshot, "taskId" | "summary">,
  events: readonly Pick<EventEnvelope, "taskId" | "summary">[],
): string[] {
  const references = new Set<string>();
  const summaries = [
    task.summary,
    ...events
      .filter((event) => event.taskId === task.taskId)
      .map((event) => event.summary),
  ];
  for (const summary of summaries) {
    for (const match of (summary ?? "").matchAll(evidenceReferences)) {
      references.add(match[0]);
    }
  }
  return [...references];
}

/** A structured reference list is authoritative, including an explicit empty list. */
export function resolveEvidenceRefs(
  task: Pick<TaskSnapshot, "taskId" | "summary">,
  events: readonly Pick<EventEnvelope, "taskId" | "summary">[],
  explicitIds?: readonly string[],
): string[] {
  return explicitIds === undefined
    ? extractEvidenceRefs(task, events)
    : [...new Set(explicitIds.filter((id) => evidenceId.test(id)))];
}

export interface EvidenceFailure {
  evidenceId: string;
  message: string;
}

export interface EvidenceLoadResult {
  records: EvidenceSummary[];
  failures: EvidenceFailure[];
  requestedIds: string[];
  truncated: boolean;
  skippedParentIds: string[];
  cancelled: boolean;
}

export type EvidenceReader = Pick<MotionClient, "evidence">;

interface EvidenceLoadOptions {
  isCurrent?: () => boolean;
  onProgress?: (result: EvidenceLoadResult) => void;
}

/** A bounded GET-only traversal. Ownership is checked before following parents. */
export async function loadTaskEvidence(
  client: EvidenceReader,
  taskId: string,
  references: readonly string[],
  options: EvidenceLoadOptions = {},
): Promise<EvidenceLoadResult> {
  const queue: string[] = [];
  const queued = new Set<string>();
  const attempted = new Set<string>();
  const records = new Map<string, EvidenceSummary>();
  const failures = new Map<string, EvidenceFailure>();
  const skippedParents = new Set<string>();
  let truncated = false;
  let cursor = 0;
  let active = 0;
  const isCurrent = options.isCurrent ?? (() => true);

  function enqueue(id: string, parent = false) {
    if (!evidenceId.test(id)) {
      if (parent) skippedParents.add(id);
      return;
    }
    if (queued.has(id)) return;
    if (queue.length >= MAX_TASK_EVIDENCE) {
      truncated = true;
      return;
    }
    queued.add(id);
    queue.push(id);
  }

  for (const id of references) enqueue(id);

  function snapshot(): EvidenceLoadResult {
    return {
      records: queue.flatMap((id) => {
        const record = records.get(id);
        return record ? [record] : [];
      }),
      failures: queue.flatMap((id) => {
        const failure = failures.get(id);
        return failure ? [failure] : [];
      }),
      requestedIds: [...attempted],
      truncated,
      skippedParentIds: [...skippedParents],
      cancelled: !isCurrent(),
    };
  }

  return new Promise<EvidenceLoadResult>((resolve) => {
    function pump() {
      while (
        isCurrent() &&
        active < EVIDENCE_CONCURRENCY &&
        cursor < queue.length
      ) {
        const id = queue[cursor++];
        attempted.add(id);
        ++active;
        void Promise.resolve()
          .then(() => client.evidence(taskId, id))
          .then((record) => {
            if (!isCurrent()) return;
            if (record.taskId !== taskId || record.evidenceId !== id) {
              throw new Error("证据与当前任务或引用不一致，已忽略。");
            }
            records.set(id, record);
            for (const parentId of record.parentIds) enqueue(parentId, true);
          })
          .catch((cause: unknown) => {
            if (!isCurrent()) return;
            failures.set(id, {
              evidenceId: id,
              message:
                cause instanceof Error
                  ? cause.message
                  : "公开证据读取失败，请重试。",
            });
          })
          .finally(() => {
            --active;
            if (isCurrent()) options.onProgress?.(snapshot());
            pump();
          });
      }
      if (active === 0) resolve(snapshot());
    }
    pump();
  });
}

const sourcePriority: Record<EvidenceSummary["sourceKind"], number> = {
  MODEL_OUTPUT: 0,
  TOOL_RESPONSE: 1,
  HOST_CHECK: 2,
  USER_INPUT: 3,
  TRUSTED_CATALOG: 4,
};

export function groupTaskEvidence(records: readonly EvidenceSummary[]): {
  primary: EvidenceSummary[];
  supporting: EvidenceSummary[];
} {
  const ordered = [...records].sort(
    (left, right) =>
      sourcePriority[left.sourceKind] - sourcePriority[right.sourceKind],
  );
  return {
    primary: ordered.filter((record) => sourcePriority[record.sourceKind] < 3),
    supporting: ordered.filter(
      (record) => sourcePriority[record.sourceKind] >= 3,
    ),
  };
}

/** Explicit reasoning markers are not public final output. Never render them. */
export function hasReasoningExcerpt(record: EvidenceSummary): boolean {
  return (
    record.sourceKind === "MODEL_OUTPUT" &&
    /(?:<|&lt;)\/?(?:think|analysis|reasoning)\b/i.test(record.excerpt)
  );
}
