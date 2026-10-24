import { useEffect, useId, useMemo, useState } from "react";
import {
  ArrowClockwise,
  CaretDown,
  Files,
  WarningCircle,
} from "@phosphor-icons/react";
import type { EvidenceSummary, EventEnvelope, TaskSnapshot } from "../api/types";
import {
  groupTaskEvidence,
  hasReasoningExcerpt,
  loadTaskEvidence,
  MAX_TASK_EVIDENCE,
  resolveEvidenceRefs,
  type EvidenceLoadResult,
  type EvidenceReader,
} from "../lib/evidence-refs";
import { formatDate, formatTime } from "../lib/format";
import { Button } from "./ui";
import "./task-evidence.css";

export interface TaskEvidenceProps {
  client: EvidenceReader;
  task: TaskSnapshot;
  events: readonly EventEnvelope[];
  evidenceIds?: readonly string[];
}

const sourceLabels: Record<EvidenceSummary["sourceKind"], string> = {
  MODEL_OUTPUT: "模型输出",
  TOOL_RESPONSE: "外部资料",
  HOST_CHECK: "主机检查",
  USER_INPUT: "用户输入",
  TRUSTED_CATALOG: "可信目录",
};

const trustLabels: Record<EvidenceSummary["trust"], string> = {
  USER_TRUSTED: "用户提供",
  HOST_OBSERVED: "主机观测",
  EXTERNAL_UNTRUSTED: "外部未信任内容",
  MODEL_DERIVED: "模型派生内容",
};

function EvidenceRecord({
  record,
  direct,
}: {
  record: EvidenceSummary;
  direct: boolean;
}) {
  const titleId = useId();
  const withheld = hasReasoningExcerpt(record);
  return (
    <article className="task-evidence-record" aria-labelledby={titleId}>
      <header className="task-evidence-record-heading">
        <h3 id={titleId}>{sourceLabels[record.sourceKind]}</h3>
        <span className="task-evidence-origin">
          {direct ? "任务引用" : "父证据"}
        </span>
      </header>
      <div className="task-evidence-tags">
        <code>{record.sourceKind}</code>
        <span
          className={`task-evidence-trust ${record.trust === "EXTERNAL_UNTRUSTED" ? "is-untrusted" : ""}`}
        >
          {trustLabels[record.trust]} · {record.trust}
        </span>
      </div>
      {withheld ? (
        <p className="task-evidence-withheld">
          此模型摘录包含推理标记，未展示。来源、时间与哈希保留如下。
        </p>
      ) : record.excerpt ? (
        <pre className="task-evidence-excerpt">{record.excerpt}</pre>
      ) : (
        <p className="task-evidence-withheld">此记录未提供公开摘录。</p>
      )}
      <div className="task-evidence-record-footer">
        <code>{record.evidenceId}</code>
        <time dateTime={record.recordedAt}>
          {formatDate(record.recordedAt)} {formatTime(record.recordedAt)}（上海）
        </time>
      </div>
      <details className="task-evidence-metadata">
        <summary>来源与校验字段</summary>
        <dl>
          <dt>记录时间</dt>
          <dd><code>{record.recordedAt}</code></dd>
          <dt>任务 ID</dt>
          <dd><code>{record.taskId}</code></dd>
          <dt>内容哈希</dt>
          <dd><code>{record.contentHash}</code></dd>
          <dt>父链哈希</dt>
          <dd><code>{record.parentClosureHash}</code></dd>
          <dt>父证据 ID</dt>
          <dd>
            {record.parentIds.length ? (
              record.parentIds.map((parentId, index) => (
                <code className="task-evidence-parent-id" key={`${parentId}:${index}`}>
                  {parentId}
                </code>
              ))
            ) : "无父证据"}
          </dd>
        </dl>
      </details>
    </article>
  );
}

function EvidencePanel({
  client,
  taskId,
  referenceIds,
}: {
  client: EvidenceReader;
  taskId: string;
  referenceIds: string[];
}) {
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const referencesKey = referenceIds.join(",");
  const identity = useMemo(
    () => ({ client, taskId, referencesKey, retry }),
    [client, taskId, referencesKey, retry],
  );
  const [load, setLoad] = useState<{
    identity: typeof identity;
    loading: boolean;
    result: EvidenceLoadResult | null;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoad({ identity, loading: true, result: null });
    void loadTaskEvidence(
      identity.client,
      identity.taskId,
      identity.referencesKey.split(","),
      {
        isCurrent: () => current,
        onProgress: (result) => {
          if (current) setLoad({ identity, loading: true, result });
        },
      },
    ).then((result) => {
      if (current) setLoad({ identity, loading: false, result });
    });
    return () => {
      current = false;
    };
  }, [identity, open]);

  // Hide an old connection's records immediately, before effect cleanup runs.
  const visible = load?.identity === identity ? load : null;
  const result = visible?.result;
  const loading = !visible || visible.loading;
  const groups = groupTaskEvidence(result?.records ?? []);
  const roots = new Set(referenceIds);

  return (
    <details
      className="task-evidence"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="task-evidence-toggle">
        <span className="task-evidence-title">
          <Files size={18} aria-hidden="true" />
          <strong>资料与模型记录</strong>
        </span>
        <span className="task-evidence-toggle-meta">
          {referenceIds.length} 条引用
          <CaretDown size={15} aria-hidden="true" />
        </span>
      </summary>
      {open && (
        <div className="task-evidence-body" aria-busy={loading}>
          <p className="task-evidence-notice">
            以下为公共 API 的原文摘录，保留各自的信任标记。
            记录本身不代表任务成功或来源已核实。
          </p>
          {loading && (
            <div className="task-evidence-loading" role="status">
              <span className="task-evidence-skeleton" aria-hidden="true" />
              正在读取公开记录
              {result?.records.length ? ` · 已读取 ${result.records.length} 条` : ""}
            </div>
          )}
          {groups.primary.map((record) => (
            <EvidenceRecord
              record={record}
              direct={roots.has(record.evidenceId)}
              key={record.evidenceId}
            />
          ))}
          {groups.supporting.length > 0 && (
            <details className="task-evidence-supporting">
              <summary>来源与父证据 · {groups.supporting.length} 条</summary>
              {groups.supporting.map((record) => (
                <EvidenceRecord
                  record={record}
                  direct={roots.has(record.evidenceId)}
                  key={record.evidenceId}
                />
              ))}
            </details>
          )}
          {Boolean(result?.failures.length) && (
            <div className="task-evidence-errors" role="alert">
              <p><WarningCircle size={16} aria-hidden="true" />部分记录读取失败</p>
              <ul>
                {result!.failures.map((failure) => (
                  <li key={failure.evidenceId}>
                    <code>{failure.evidenceId}</code>
                    <span>{failure.message}</span>
                  </li>
                ))}
              </ul>
              <Button
                variant="secondary"
                size="sm"
                disabled={loading}
                onClick={() => setRetry((value) => value + 1)}
              >
                <ArrowClockwise size={13} aria-hidden="true" />重新读取
              </Button>
            </div>
          )}
          {result?.truncated && (
            <p className="task-evidence-limit">
              引用链超过 {MAX_TASK_EVIDENCE} 条，本次只读取前 {MAX_TASK_EVIDENCE} 条，
              其余记录未读取。
            </p>
          )}
          {Boolean(result?.skippedParentIds.length) && (
            <p className="task-evidence-limit">
              部分父引用不符合公开证据 ID 格式，未读取。
            </p>
          )}
          <p className="task-evidence-footnote">
            按引用追溯父证据，每次最多读取 {MAX_TASK_EVIDENCE} 条；只读操作不触发模型或付款。
          </p>
        </div>
      )}
    </details>
  );
}

export function TaskEvidence({ client, task, events, evidenceIds }: TaskEvidenceProps) {
  const references = resolveEvidenceRefs(task, events, evidenceIds);
  if (!references.length) return null;
  return (
    <EvidencePanel
      key={task.taskId}
      client={client}
      taskId={task.taskId}
      referenceIds={references}
    />
  );
}
