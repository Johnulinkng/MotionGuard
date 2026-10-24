import {
  ArrowRight,
  ArrowsClockwise,
  Brain,
  Check,
  CheckCircle,
  Clock,
  Database,
  FileText,
  Fingerprint,
  GitBranch,
  HourglassMedium,
  Info,
  ListChecks,
  Lock,
  MagnifyingGlass,
  Pause,
  Play,
  ShieldCheck,
  ShieldWarning,
  Sparkle,
  Stack,
  Stop,
  TreeStructure,
  Wallet,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import type {
  BudgetView,
  Catalog,
  EventEnvelope,
  LessonView,
  PaymentView,
  ResourcePlan,
  ReviewView,
  TaskSnapshot,
  TaskResult,
} from "../api/types";
import {
  decisionLabels,
  paymentLabels,
  reasonLabels,
  resourceLabels,
  taskLabels,
  tones,
} from "../labels";
import { formatDate, formatTime, formatUsdc, shortId } from "../lib/format";
import { modelExecutionLabel, roleExecutionLabel } from "../lib/runtime";
import { Badge, Button, EmptyState } from "./ui";

export type TaskTab = "events" | "plan" | "payments" | "lessons";

export function BudgetPanel({
  budget,
  mode,
}: {
  budget: BudgetView;
  mode: string;
}) {
  const segments = [
    ["settled", "已结算", budget.settledAtomic],
    ["reserved", "已预占", budget.reservedAtomic],
    ["outstanding", "待确认占用", budget.outstandingAtomic],
    ["available", "可用额度", budget.availableAtomic],
  ];
  const limit = BigInt(budget.limitAtomic);
  return (
    <section className="panel budget-panel" aria-label="任务预算">
      <div className="panel-title">
        <h2>任务预算</h2>
        <Wallet size={17} />
      </div>
      <div className="budget-value">
        {formatUsdc(budget.availableAtomic)}
        <span>/ {formatUsdc(budget.limitAtomic)} USDC</span>
      </div>
      <div className="budget-caption">
        剩余可用额度
        {mode === "MOCK" ? " · 模拟资金" : " · Base Sepolia 测试资产"}
      </div>
      <div className="budget-bar" aria-hidden="true">
        {segments.map(([key, , amount]) => (
          <div
            key={key}
            className={`budget-segment ${key}`}
            style={{
              width: `${limit > 0n ? Number((BigInt(amount) * 10000n) / limit) / 100 : 0}%`,
            }}
          />
        ))}
      </div>
      {segments.map(([key, label, amount]) => (
        <div className="budget-row" key={key}>
          <span>
            <i className={`legend-dot ${key}`} />
            {label}
          </span>
          <strong>{formatUsdc(amount)} USDC</strong>
        </div>
      ))}
      <div className="budget-notice">
        <Info size={13} />
        <span>
          结算未知的授权继续占用额度。撤销授权不会释放可能仍被兑付的资金。
        </span>
      </div>
    </section>
  );
}

export function AgentPanel({ result }: { task: TaskSnapshot; result?: TaskResult | null }) {
  return (
    <section className="panel agents-panel">
      <h2>Agent 协作</h2>
      {[
        {
          icon: FileText,
          title: "业务执行",
          en: "WORKER",
          text: roleExecutionLabel(result, "worker"),
          tone: "",
        },
        {
          icon: ShieldCheck,
          title: "威胁检查",
          en: "THREAT REVIEWER",
          text: roleExecutionLabel(result, "threat"),
          tone: "",
        },
        {
          icon: GitBranch,
          title: "目标一致性",
          en: "CONSISTENCY REVIEWER",
          text: roleExecutionLabel(result, "consistency"),
          tone: "",
        },
        {
          icon: Brain,
          title: "经验整理",
          en: "LESSON CURATOR",
          text: roleExecutionLabel(result, "curator"),
          tone: "muted",
        },
      ].map(({ icon: Icon, title, en, text, tone }) => (
        <div className="agent-row" key={title}>
          <span className="agent-symbol">
            <Icon size={15} />
          </span>
          <div>
            <strong>{title}</strong>
            <small>{en}</small>
          </div>
          <span className={`agent-state ${tone}`}>
            <span className="dot" />
            {text}
          </span>
        </div>
      ))}
      <p className="form-hint" style={{ marginTop: 17, fontSize: 9 }}>
        模型来源：{modelExecutionLabel(result)}。角色状态按后端调用诊断显示。
        {result?.learningMode === "NO_ONLINE_LABELS" && "本任务没有真实攻击标签，不自动晋升经验。"}
      </p>
    </section>
  );
}

export function PaymentTable({
  payments,
  catalog,
  onSelect,
  completedWithoutPayments = false,
}: {
  payments: PaymentView[];
  catalog: Catalog | null;
  onSelect: (p: PaymentView) => void;
  completedWithoutPayments?: boolean;
}) {
  if (!payments.length)
    return (
      <EmptyState
        icon={<Wallet size={30} />}
        title={completedWithoutPayments ? "任务已完成，未产生付款" : "当前没有付款记录"}
        description={completedWithoutPayments
          ? "本次任务没有付费请求，结果见任务工作台的摘要与执行轨迹。"
          : "如产生付费请求，付款判定、授权和回执会记录在这里。"}
      />
    );
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>资源 / 商家</th>
            <th>请求金额</th>
            <th>判定</th>
            <th>付款状态</th>
            <th>
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {payments.map((payment) => (
            <tr key={payment.paymentId}>
              <td>
                <strong>{resourceLabels[payment.resourceKind]}</strong>
                <small>
                  {catalog?.vendors.find((v) => v.vendorId === payment.vendorId)
                    ?.name ?? payment.vendorId}
                </small>
              </td>
              <td>
                <strong>{formatUsdc(payment.amountAtomic)} USDC</strong>
                <small>
                  {payment.executionMode} · {payment.authorizationStatus}
                </small>
              </td>
              <td>
                <Badge
                  tone={
                    payment.decision.type === "BLOCK"
                      ? "red"
                      : payment.decision.type === "REVIEW"
                        ? "amber"
                        : "green"
                  }
                >
                  {decisionLabels[payment.decision.type]}
                </Badge>
              </td>
              <td>
                <span>{paymentLabels[payment.state]}</span>
                <small>
                  回执 {payment.receipt.status}
                  {payment.executionMode === "MOCK" ? " · 仅模拟" : ""}
                </small>
              </td>
              <td>
                <button
                  className="table-action"
                  onClick={() => onSelect(payment)}
                  aria-label={`查看付款 ${payment.paymentId}`}
                >
                  详情 <ArrowRight size={11} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PlanView({
  plan,
  catalog,
}: {
  plan: ResourcePlan | null;
  catalog: Catalog | null;
}) {
  if (!plan)
    return (
      <EmptyState
        icon={<ListChecks size={30} />}
        title="资源计划尚未生成"
        description="仅根据原始目标和可信目录规划。计划确认前，任务不会读取外部资料。"
      />
    );
  return (
    <div>
      <div className="plan-summary">
        <span>
          资源计划{" "}
          <Badge tone={plan.status === "FROZEN" ? "green" : "amber"}>
            {plan.status === "FROZEN" ? "已冻结" : "待确认"}
          </Badge>
        </span>
        <span>
          总上限 <strong>{formatUsdc(plan.totalCapAtomic)}</strong> USDC
        </span>
      </div>
      {plan.items.map((item, index) => (
        <article className="resource-card" key={item.itemId}>
          <h3>
            {String(index + 1).padStart(2, "0")} /{" "}
            {resourceLabels[item.resourceKind]} ·{" "}
            {catalog?.vendors.find((v) => v.vendorId === item.vendorId)?.name ??
              item.vendorId}
          </h3>
          <p>{item.purpose}</p>
          <div className="resource-tags">
            <span>{item.toolId}</span>
            <span>{item.routeId}</span>
            {item.selectors.entityIds?.map((id) => (
              <span key={id}>{id}</span>
            ))}
          </div>
          <div className="resource-price">
            <span>
              {catalog?.vendors.find(vendor => vendor.vendorId === item.vendorId)?.billing?.kind === "FREE_PUBLIC_DATA" ? "最多读取" : "最多"} {item.maxPaidCalls} 次 · 单价上限{" "}
              {formatUsdc(item.unitPriceCapAtomic)} USDC
            </span>
            <strong>小计 ≤ {formatUsdc(item.subtotalCapAtomic)} USDC</strong>
          </div>
          <p>
            依赖资源：{item.dependsOn.length ? item.dependsOn.join("、") : "无"}
          </p>
        </article>
      ))}
      <div className="plan-note">
        有效至 {formatDate(plan.expiresAt)} {formatTime(plan.expiresAt)}（上海）
        <br />
        <span className="mono">{plan.planHash}</span>
      </div>
    </div>
  );
}

export function LessonCards({
  lessons,
  mock,
  onSelect,
}: {
  lessons: LessonView[];
  mock: boolean;
  onSelect: (lesson: LessonView) => void;
}) {
  if (!lessons.length)
    return (
      <section className="panel">
        <EmptyState
          icon={<Brain size={34} />}
          title="这个任务还没有防御经验"
          description="经验候选经过来源校验、变体、良性反例与回归验证后，才会进入可用经验。"
        />
      </section>
    );
  return (
    <div className="lesson-grid">
      {lessons.map((lesson) => (
        <article className="panel lesson-card" key={lesson.lessonId}>
          <div className="lesson-top">
            <div className="lesson-symbol">
              <Brain size={19} />
            </div>
            <Badge
              tone={
                lesson.status === "ACTIVE"
                  ? "green"
                  : lesson.status === "QUARANTINED"
                    ? "amber"
                    : "neutral"
              }
            >
              {lesson.status === "ACTIVE"
                ? "已晋升"
                : lesson.status === "QUARANTINED"
                  ? "隔离验证"
                  : "已撤回"}
              {mock ? " · MOCK" : ""}
            </Badge>
          </div>
          <h3>{lesson.mechanism}</h3>
          <p>{lesson.summary}</p>
          <div className="lesson-checks">
            <span>
              {lesson.promotion.originReplayPassed ? (
                <CheckCircle size={12} />
              ) : (
                <Clock size={12} />
              )}
              原事件回放
            </span>
            <span>
              <Stack size={12} />
              {lesson.promotion.variantPassed} 个变体
            </span>
            <span>
              <ShieldCheck size={12} />
              {lesson.promotion.benignPassed} 个良性反例
            </span>
            <span>
              {lesson.promotion.permissionsUnchanged ? (
                <Lock size={12} />
              ) : (
                <WarningCircle size={12} />
              )}
              权限边界
              {lesson.promotion.permissionsUnchanged ? "不变" : "待验证"}
            </span>
          </div>
          <div className="lesson-card-footer">
            <span>
              {lesson.memoryVersion} · v{lesson.version}
            </span>
            <button className="text-link" onClick={() => onSelect(lesson)}>
              验证记录 <ArrowRight size={11} />
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

export function EventTimeline({
  events,
  task,
}: {
  events: EventEnvelope[];
  task: TaskSnapshot;
}) {
  if (!events.length)
    return (
      <div className="timeline">
        <div className="timeline-item">
          <span className="timeline-icon">
            <Database size={12} />
          </span>
          <div className="timeline-main">
            <div className="timeline-title">
              <span>任务快照已同步</span>
              <time>{formatTime(task.updatedAt)}</time>
            </div>
            <p>{task.summary || taskLabels[task.status]}</p>
            <span className="timeline-tag">
              v{task.version} · {task.executionMode} · 连接后新事件将显示于此
            </span>
          </div>
        </div>
      </div>
    );
  return (
    <div className="timeline">
      {[...events].reverse().map((event) => {
        const review = event.type.startsWith("review.");
        const icon = review ? (
          <Pause size={11} weight="fill" />
        ) : event.type === "task.completed" ? (
          <Check size={12} />
        ) : event.resourceType === "PAYMENT" ? (
          <Wallet size={12} />
        ) : event.resourceType === "LESSON" ? (
          <Brain size={12} />
        ) : event.resourceType === "PLAN" ? (
          <ListChecks size={12} />
        ) : (
          <ShieldCheck size={12} />
        );
        return (
          <div className="timeline-item" key={event.eventId}>
            <span className={`timeline-icon ${review ? "amber" : ""}`}>
              {icon}
            </span>
            <div className="timeline-main">
              <div className="timeline-title">
                <span>{eventLabels[event.type] ?? event.type}</span>
                <time>{formatTime(event.occurredAt)}</time>
              </div>
              <p>{event.summary}</p>
              <span className="timeline-tag">
                {event.resourceType} · seq {event.seq} · {event.executionMode}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const eventLabels: Record<string, string> = {
  "task.created": "任务已创建",
  "task.updated": "任务状态更新",
  "plan.planning": "生成资源计划",
  "plan.ready": "资源计划已就绪",
  "authorization.frozen": "授权与资源计划已冻结",
  "run.started": "Agent 开始执行",
  "review.required": "付款请求需要人工复核",
  "review.resolved": "复核决定已记录",
  "review.expired": "复核已过期",
  "payment.updated": "付款状态更新",
  "budget.updated": "资金快照更新",
  "lesson.promoted": "防御经验已晋升",
  "task.completed": "任务已结束",
  "task.cancelled": "任务已取消",
  "authorization.revoked": "任务授权已撤销",
};

export function TaskPanel({
  task,
  plan,
  payments,
  reviews,
  lessons,
  events,
  catalog,
  tab,
  setTab,
  busy,
  stale = false,
  connection,
  onPlan,
  onAuthorize,
  onRun,
  onReview,
  onPayment,
  onLesson,
  onCancel,
  onRevoke,
  onRefresh,
  result,
  resultError,
  resultPending = false,
}: {
  task: TaskSnapshot;
  plan: ResourcePlan | null;
  payments: PaymentView[];
  reviews: ReviewView[];
  lessons: LessonView[];
  events: EventEnvelope[];
  catalog: Catalog | null;
  tab: TaskTab;
  setTab: (tab: TaskTab) => void;
  busy: boolean;
  stale?: boolean;
  connection: string;
  onPlan: () => void;
  onAuthorize: () => void;
  onRun: () => void;
  onReview: (review: ReviewView) => void;
  onPayment: (p: PaymentView) => void;
  onLesson: (l: LessonView) => void;
  onCancel: () => void;
  onRevoke: () => void;
  onRefresh: () => void;
  result?: TaskResult | null;
  resultError?: Error | null;
  resultPending?: boolean;
}) {
  const step =
    task.status === "COMPLETED"
      ? 4
      : task.status === "DRAFT" || task.status === "PLANNING"
        ? 0
        : task.status === "AWAITING_AUTHORIZATION"
          ? 1
          : task.status === "READY"
            ? 2
            : 3;
  const actionBusy = busy || stale;
  const pending = reviews.find((review) => review.status === "PENDING");
  const cancelled = task.status === "CANCELLED" || task.status === "FAILED";
  return (
    <section className="panel">
      <div className="panel-heading">
        <div className="panel-title">
          <Stack size={17} />
          <h2>当前任务</h2>
        </div>
        <button className="text-link" onClick={onRefresh} disabled={busy}>
          <ArrowsClockwise size={12} />
          刷新快照
        </button>
      </div>
      <div className="task-content">
        <div className="task-topline">
          <span className="task-id">{task.taskId}</span>
          <Badge tone={tones[task.status]}>
            <span className="dot" />
            {taskLabels[task.status]}
          </Badge>
        </div>
        <div className="task-title-row">
          <span className="task-icon">
            <FileText size={18} />
          </span>
          <div>
            <h3 className="task-title">{task.goal}</h3>
            <div className="task-metadata">
              <span>
                <Clock size={10} />
                {formatDate(task.createdAt)} {formatTime(task.createdAt)}
              </span>
              <span>
                <ShieldCheck size={10} />
                {task.authorization
                  ? `授权 v${task.authorization.version}`
                  : "尚未授权"}
              </span>
              <span>{task.executionMode}</span>
              <span>模型：{modelExecutionLabel(result)}</span>
            </div>
          </div>
        </div>
        <div className="flow-steps">
          {["创建与规划", "确认计划", "冻结授权", "运行与审计"].map(
            (label, index) => (
              <div
                className={`flow-step ${index < step ? "done" : index === step ? "current" : ""}`}
                key={label}
              >
                <i className="step-circle">
                  {index < step ? (
                    <Check size={11} />
                  ) : (
                    String(index + 1).padStart(2, "0")
                  )}
                </i>
                <span>{label}</span>
              </div>
            ),
          )}
        </div>
        {task.status === "DRAFT" && (
          <div className="review-callout">
            <ListChecks size={17} />
            <div>
              <h3>先规划资源，再读取外部内容</h3>
              <p>使用原始目标与可信目录生成资源计划，确认后再授权。</p>
            </div>
            <Button size="sm" disabled={actionBusy} onClick={onPlan}>
              生成资源计划 <ArrowRight size={11} />
            </Button>
          </div>
        )}
        {task.status === "PLANNING" && (
          <div className="review-callout">
            <HourglassMedium size={17} />
            <div>
              <h3>正在生成资源计划</h3>
              <p>尚未授权付款，也没有读取不可信内容。</p>
            </div>
          </div>
        )}
        {task.status === "AWAITING_AUTHORIZATION" && (
          <div className="review-callout">
            <Fingerprint size={17} />
            <div>
              <h3>资源计划已就绪，等待你的确认</h3>
              <p>检查商家、单价、调用次数与总预算后，冻结本次授权。</p>
            </div>
            <Button
              size="sm"
              disabled={actionBusy || !plan}
              onClick={onAuthorize}
            >
              查看并确认计划 <ArrowRight size={11} />
            </Button>
          </div>
        )}
        {task.status === "READY" && (
          <div className="review-callout">
            <Lock size={17} />
            <div>
              <h3>授权已冻结，任务可以开始</h3>
              <p>执行范围固定为本次确认的计划，Agent 无法自行扩权。</p>
            </div>
            <Button size="sm" disabled={actionBusy} onClick={onRun}>
              <Play size={11} />
              开始执行
            </Button>
          </div>
        )}
        {pending && (
          <div className="review-callout">
            <ShieldWarning size={17} />
            <div>
              <h3>有一笔计划内付款需要你的复核</h3>
              <p>
                {formatUsdc(pending.amountAtomic)} USDC ·{" "}
                {reasonLabels[pending.reasonCode] || pending.reasonCode}
                。复核期间不会产生新付款授权。
              </p>
            </div>
            <Button
              size="sm"
              disabled={actionBusy}
              onClick={() => onReview(pending)}
            >
              处理复核 <ArrowRight size={11} />
            </Button>
          </div>
        )}
        {task.status === "AWAITING_SETTLEMENT" && (
          <div className="review-callout">
            <HourglassMedium size={17} />
            <div>
              <h3>结算状态未知，额度保持占用</h3>
              <p>{task.summary} 请等待权威状态更新，避免重复付款。</p>
            </div>
          </div>
        )}
        {!result && (task.status === "COMPLETED" || cancelled) && (
          <div
            className={`detail-notice ${task.status === "COMPLETED" ? "result-note" : ""}`}
            style={{ marginBottom: 0, fontSize: 13, lineHeight: 1.8 }}
          >
            <strong>{task.status === "COMPLETED" ? "任务结果（后端摘要）" : "任务状态（后端摘要）"}</strong>
            <p style={{ margin: "7px 0", whiteSpace: "pre-wrap" }}>{task.summary || taskLabels[task.status]}</p>
            {task.executionMode === "MOCK" && (
              <span> 付款为 MOCK 沙箱记录，不代表链上付款、防护效果或学习收益。</span>
            )}
          </div>
        )}
        {resultError && <div className="form-error" role="alert">完整结果读取失败：{resultError.message}。可刷新快照重新读取；不会重新执行任务。</div>}
        {resultPending && <p className="form-hint" role="status">完整报告正在生成，正在重新读取结果；不会重新执行任务。</p>}
        {result && <TaskResultView result={result} />}
      </div>
      <div className="task-tabs" role="tablist" aria-label="任务详情">
        {(
          [
            ["events", "执行轨迹", events.length],
            ["plan", "资源计划", plan?.items.length ?? 0],
            ["payments", "付款记录", payments.length],
            ["lessons", "防御经验", lessons.length],
          ] as const
        ).map(([key, label, count]) => (
          <button
            role="tab"
            aria-selected={tab === key}
            id={`tab-${key}`}
            aria-controls="task-tabpanel"
            key={key}
            onClick={() => setTab(key)}
            className={tab === key ? "active" : ""}
          >
            {label}
            {count > 0 && <span className="tab-count">{count}</span>}
          </button>
        ))}
      </div>
      <div id="task-tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "events" && <EventTimeline events={events} task={task} />}
        {tab === "plan" && <PlanView plan={plan} catalog={catalog} />}
        {tab === "payments" && (
          <PaymentTable
            payments={payments}
            catalog={catalog}
            onSelect={onPayment}
            completedWithoutPayments={task.status === "COMPLETED" && payments.length === 0}
          />
        )}
        {tab === "lessons" && (
          <div style={{ padding: lessons.length ? 20 : 0 }}>
            <LessonCards
              lessons={lessons}
              mock={task.executionMode === "MOCK"}
              onSelect={onLesson}
            />
          </div>
        )}
      </div>
      <div className="panel-footer">
        <span>
          <span
            className="dot"
            style={{
              color: connection === "connected" ? "#91a874" : "#bfaa72",
            }}
          />
          {connection === "connected"
            ? "实时事件已连接"
            : connection === "reconnecting"
              ? "事件流重连中"
              : connection === "error"
                ? "事件流离线 · 定时同步快照"
                : "正在同步"}{" "}
          · v{task.version}
        </span>
        <div className="inline-actions">
          {!["CANCELLED", "COMPLETED", "FAILED"].includes(task.status) && (
            <button
              className="text-link"
              onClick={onCancel}
              disabled={actionBusy}
            >
              <Stop size={10} />
              取消任务
            </button>
          )}
          {task.authorization?.status === "ACTIVE" && (
            <button
              className="text-link"
              onClick={onRevoke}
              disabled={actionBusy}
            >
              撤销授权
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

export function CatalogCards({ catalog }: { catalog: Catalog }) {
  return (
    <div className="catalog-grid">
      {catalog.vendors.map((vendor, index) => (
        <article className="panel vendor-card" key={vendor.vendorId}>
          <div className="lesson-top">
            <div className="vendor-avatar">
              {String(index + 1).padStart(2, "0")}
            </div>
            <Badge tone="green">
              <Database size={10} />
              {vendor.billing?.kind === "FREE_PUBLIC_DATA" ? "免费公开资料" : "目录登记"}
            </Badge>
          </div>
          <h3>{vendor.name}</h3>
          <p>{vendor.description}</p>
          <div className="vendor-details">
            <div>
              <span>资源类别</span>
              <strong>{resourceLabels[vendor.resourceKind]}</strong>
            </div>
            <div>
              <span>工具</span>
              <strong>{vendor.toolId}</strong>
            </div>
            <div>
              <span>允许路由</span>
              <strong>{vendor.routeId}</strong>
            </div>
          </div>
          <div className="vendor-payee">{vendor.payTo ?? "免费公开资料 · 无需收款地址"}</div>
          {vendor.source && <p className="form-hint"><a href={vendor.source.url} target="_blank" rel="noopener noreferrer">{vendor.source.name}</a></p>}
          <p className="form-hint" style={{ minHeight: 0, fontSize: 9 }}>
            目录登记不构成商家安全或服务质量保证。
          </p>
        </article>
      ))}
    </div>
  );
}

export function TaskResultView({ result }: { result: TaskResult }) {
  const succeeded = result.model.diagnostics.filter(call => call.status === "SUCCEEDED").length;
  return (
    <section aria-label="任务完整结果" style={{ marginTop: 20, overflowWrap: "anywhere" }}>
      <h3 className="detail-heading">任务完整报告</h3>
      <div className="inline-actions" style={{ flexWrap: "wrap", marginBottom: 12 }}>
        <Badge tone={result.model.mode === "LIVE_API" ? "green" : "neutral"}>{modelExecutionLabel(result)}</Badge>
        <Badge tone="neutral">{result.dataMode === "LIVE_HTTP" ? "公开资料 HTTP 模式（后端报告）" : "沙箱资料 · SANDBOX"}</Badge>
        <Badge tone="amber">付款 {result.paymentMode}</Badge>
        <Badge tone={result.status === "FAILED" ? "red" : "neutral"}>结果：{result.status === "COMPLETED" ? "已完成" : result.status === "BLOCKED" ? "已阻断" : "失败"}</Badge>
      </div>
      <p className="form-hint">后端报告：模型调用成功 {succeeded}/{result.model.diagnostics.length} 次 · 资源付款 {result.paidCalls} 次。模型 API 费用不计入此付款预算。</p>
      <div className="detail-notice result-note" data-testid="task-report" style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.9 }}>{result.report || "后端未返回报告正文。"}</div>
      <h4 className="detail-heading">资料来源（{result.sources.length} 个已登记来源）</h4>
      {result.sources.length ? <ol style={{ paddingLeft: 18, fontSize: 12, lineHeight: 1.8 }}>{result.sources.map(source => (
        <li key={source.evidenceId} style={{ marginBottom: 14 }}>
          <a href={source.url} target="_blank" rel="noopener noreferrer">{source.name}</a>
          <div>{source.url}</div>
          <small>观测于 {formatDate(source.observedAt)} {formatTime(source.observedAt)}（上海）</small>
          <div className="mono" style={{ fontSize: 10 }}>{source.contentHash}</div>
        </li>
      ))}</ol> : <p className="form-hint">本结果没有返回资料来源。</p>}
      <details style={{ margin: "18px 0", fontSize: 12, lineHeight: 1.8 }}>
        <summary>模型调用诊断（{result.model.diagnostics.length} 次）</summary>
        {result.model.diagnostics.map(call => <div key={call.callId} style={{ marginTop: 12 }}>
          <strong>{call.role}{call.phase ? ` / ${call.phase}` : ""} · {call.status === "SUCCEEDED" ? "成功" : "失败"}</strong>
          <div>请求模型 {call.requestedModel} · 实际模型 {call.actualModel ?? "未返回"} · {call.latencyMs} ms</div>
          <div>HTTP {call.httpStatus ?? "未返回"} · token 用量 {call.usage?.totalTokens ?? "未返回"}{call.errorCategory ? ` · ${call.errorCategory}` : ""}</div>
        </div>)}
      </details>
      <p className="form-hint">{result.learningMode === "NO_ONLINE_LABELS" ? "学习模式：无真实攻击标签，不自动晋升。" : "学习模式：沙箱 oracle；不代表真实学习收益。"} 付款仍为 MOCK 沙箱，未发生链上结算。</p>
    </section>
  );
}

export function PaymentDetails({ payment }: { payment: PaymentView }) {
  return (
    <>
      <p className="form-hint" style={{ marginBottom: 12 }}>
        只读付款快照 v{payment.version} · {formatDate(payment.updatedAt)}{" "}
        {formatTime(payment.updatedAt)}（上海）
      </p>
      <div className="payment-amount">
        {formatUsdc(payment.amountAtomic)}
        <small>USDC</small>
      </div>
      <div className="detail-notice">
        {payment.executionMode === "MOCK"
          ? "MOCK 付款沙箱：授权与结算按模拟状态展示，没有链上付款。"
          : "Base Sepolia 测试网记录。付款状态以公共 API 的授权状态和独立回执为准。"}
      </div>
      <dl className="detail-grid">
        <dt>执行模式</dt>
        <dd>{payment.executionMode}</dd>
        <dt>付款状态</dt>
        <dd>
          {paymentLabels[payment.state]} · {payment.state}
        </dd>
        <dt>授权状态</dt>
        <dd>{payment.authorizationStatus}</dd>
        <dt>回执状态</dt>
        <dd>{payment.receipt.status}</dd>
        <dt>收款地址</dt>
        <dd className="mono">{payment.payTo}</dd>
        <dt>网络 / 资产</dt>
        <dd>
          {payment.asset.network} / {payment.asset.symbol}
          <br />
          <span className="mono">{payment.asset.tokenAddress}</span>
        </dd>
        <dt>资源与路由</dt>
        <dd>
          {payment.vendorId} / {payment.toolId}
          <br />
          {payment.method} {payment.routeId}
        </dd>
        <dt>交易哈希</dt>
        <dd className="mono">
          {payment.receipt.transactionHash || "无链上交易哈希"}
        </dd>
        <dt>模拟回执</dt>
        <dd className="mono">{payment.receipt.mockReceiptId || "无"}</dd>
      </dl>
      <h3 className="detail-heading">
        <ShieldCheck size={14} />
        付款判定
      </h3>
      <dl className="detail-grid">
        <dt>最终判定</dt>
        <dd>
          {decisionLabels[payment.decision.type]} · {payment.decision.type}
        </dd>
        <dt>硬策略</dt>
        <dd>
          {payment.decision.hardGate === "BLOCK"
            ? "BLOCK · 禁止通过复核覆盖"
            : "PASS · 符合硬约束"}
        </dd>
        <dt>判定原因</dt>
        <dd>
          {payment.decision.summary}
          <br />
          {payment.decision.reasonCodes
            .map((code) => reasonLabels[code] || code)
            .join("、")}
        </dd>
        <dt>策略 / 经验</dt>
        <dd>
          {payment.decision.policyVersion} / {payment.decision.memoryVersion}
        </dd>
      </dl>
      <h3 className="detail-heading">
        <TreeStructure size={14} />
        独立审核记录
      </h3>
      <div className="reviewer-box">
        {payment.decision.reviewers.map((reviewer) => (
          <div className="reviewer-card" key={reviewer.role}>
            <ShieldCheck size={16} />
            <div>
              <strong>
                {reviewer.role === "THREAT"
                  ? "威胁检查 Agent"
                  : "目标一致性 Agent"}
              </strong>
              <p>{reasonLabels[reviewer.reasonCode] || reviewer.reasonCode}</p>
            </div>
            <Badge
              tone={
                reviewer.verdict === "ALLOW"
                  ? "green"
                  : reviewer.verdict === "BLOCK"
                    ? "red"
                    : "amber"
              }
            >
              {decisionLabels[reviewer.verdict]}
            </Badge>
          </div>
        ))}
      </div>
      <h3 className="detail-heading">
        <Fingerprint size={14} />
        请求绑定
      </h3>
      <dl className="detail-grid">
        <dt>请求摘要</dt>
        <dd className="mono">{payment.requestHash}</dd>
        <dt>报价摘要</dt>
        <dd className="mono">{payment.offerHash}</dd>
        <dt>计划摘要</dt>
        <dd className="mono">{payment.decision.planHash}</dd>
        <dt>授权版本</dt>
        <dd>v{payment.decision.authorizationVersion}</dd>
      </dl>
    </>
  );
}

export function LessonDetails({
  lesson,
  mock,
}: {
  lesson: LessonView;
  mock: boolean;
}) {
  const checks: Array<[string, boolean]> = [
    ["原事件回放", lesson.promotion.originReplayPassed],
    [
      `独立变体 ${lesson.promotion.variantPassed} 个（至少 2 个）`,
      lesson.promotion.variantPassed >= 2,
    ],
    [
      `良性反例 ${lesson.promotion.benignPassed} 个（至少 2 个）`,
      lesson.promotion.benignPassed >= 2,
    ],
    ["完整开发回归", lesson.promotion.regressionPassed],
    ["权限边界不变", lesson.promotion.permissionsUnchanged],
  ];
  return (
    <>
      {mock && (
        <div className="detail-notice">
          MOCK · 沙箱 oracle
          标注的闭环示例。仅展示晋升记录，不代表实际学习实验已完成或统计收益。
        </div>
      )}
      <dl className="detail-grid">
        <dt>机制</dt>
        <dd>{lesson.mechanism}</dd>
        <dt>经验内容</dt>
        <dd>{lesson.summary}</dd>
        <dt>适用范围</dt>
        <dd>{lesson.applicability}</dd>
        <dt>状态</dt>
        <dd>{lesson.status}</dd>
        <dt>经验版本</dt>
        <dd>
          {lesson.memoryVersion} · v{lesson.version}
        </dd>
        <dt>来源证据</dt>
        <dd>{lesson.sourceEvidenceIds.join("、")}</dd>
        <dt>发布时间</dt>
        <dd>
          {lesson.promotion.publishedAt
            ? `${formatDate(lesson.promotion.publishedAt)} ${formatTime(lesson.promotion.publishedAt)}（上海）`
            : "尚未发布"}
        </dd>
      </dl>
      <h3 className="detail-heading">晋升验证记录</h3>
      <div className="reviewer-box">
        {checks.map(([label, passed]) => (
          <div className="reviewer-card" key={label}>
            {passed ? <CheckCircle size={17} /> : <XCircle size={17} />}
            <strong style={{ flex: 1 }}>{label}</strong>
            <Badge tone={passed ? "green" : "amber"}>
              {passed ? "通过" : "未通过"}
            </Badge>
          </div>
        ))}
      </div>
      <p className="form-hint" style={{ marginTop: 18 }}>
        防御经验只用于收紧识别与复核，不增加预算、商家、资源或执行权限。
      </p>
    </>
  );
}

export function SessionTasks({
  tasks,
  onSelect,
  selectedId,
}: {
  tasks: TaskSnapshot[];
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div className="panel-title">
          <Stack size={16} />
          <h2>本会话任务</h2>
        </div>
        <span className="event-count">
          {tasks.length} 个 · 仅当前浏览器会话
        </span>
      </div>
      {tasks.length ? (
        tasks.map((task) => (
          <button
            className="task-list-row"
            key={task.taskId}
            onClick={() => onSelect(task.taskId)}
            aria-current={selectedId === task.taskId}
          >
            <span className="task-icon">
              <FileText size={16} />
            </span>
            <div>
              <h3>{task.goal}</h3>
              <p>
                {shortId(task.taskId, 12)} · {formatDate(task.createdAt)}{" "}
                {formatTime(task.createdAt)}
              </p>
            </div>
            <Badge tone={tones[task.status]}>{taskLabels[task.status]}</Badge>
            <ArrowRight className="arrow" size={13} />
          </button>
        ))
      ) : (
        <EmptyState
          icon={<MagnifyingGlass size={24} />}
          title="本会话没有任务"
          description="创建任务或使用任务 ID 打开已有任务。"
        />
      )}
    </section>
  );
}

export function Welcome({
  connected,
  busy,
  onNew,
  onDemo,
  onConnect,
}: {
  connected: boolean;
  busy: boolean;
  onNew: () => void;
  onDemo: () => void;
  onConnect: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div className="panel-title">
          <Stack size={17} />
          <h2>任务工作台</h2>
        </div>
        <span className="small-caps">YOUR GOAL. YOUR BOUNDARIES.</span>
      </div>
      <div className="onboarding">
        <ShieldCheck size={46} weight="thin" />
        <h2>让 Agent 行动，让授权有边界。</h2>
        <p>
          先确认任务目标与资源计划，再让 Agent
          执行。每次付款都能追踪到原始授权、审核判断和资金状态。
        </p>
        <div className="inline-actions" style={{ justifyContent: "center" }}>
          <Button disabled={!connected || busy} onClick={onNew}>
            创建第一个任务 <ArrowRight size={13} />
          </Button>
          {connected ? (
            <Button variant="secondary" disabled={busy} onClick={onDemo}>
              <Play size={12} />
              体验模拟流程
            </Button>
          ) : (
            <Button variant="secondary" onClick={onConnect}>
              配置连接
            </Button>
          )}
        </div>
      </div>
      <div className="welcome-principles">
        <div>
          <ListChecks size={17} />
          <strong>先确认资源计划</strong>
          <p>商家、价格和次数对你可见</p>
        </div>
        <div>
          <ShieldCheck size={17} />
          <strong>再检查每次付款</strong>
          <p>硬约束与语义判断分别记录</p>
        </div>
        <div>
          <Sparkle size={17} />
          <strong>把经验留在边界内</strong>
          <p>经过验证，且不能改变权限</p>
        </div>
      </div>
    </section>
  );
}
