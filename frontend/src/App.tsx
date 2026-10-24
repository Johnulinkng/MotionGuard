import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowRight,
  Bell,
  Brain,
  CalendarBlank,
  CaretRight,
  Check,
  CheckCircle,
  CircleNotch,
  Command,
  Database,
  DownloadSimple,
  FileText,
  House,
  Info,
  List,
  Lock,
  MagnifyingGlass,
  PlugsConnected,
  Plus,
  Question,
  ShieldCheck,
  ShieldWarning,
  SlidersHorizontal,
  Stack,
  WarningCircle,
  Wallet,
  X,
} from "@phosphor-icons/react";
import { ApiError, MotionClient } from "./api/client";
import { CONTRACT_VERSION } from "./api/types";
import { initialSimulatorControls, scenarioForConnection } from "./api/profile";
import { OverviewHero } from "./components/overview";
import { TaskEvidence } from "./components/task-evidence";
import type {
  Catalog,
  CreateTask,
  EvidenceSummary,
  ExecutionMode,
  LessonView,
  PaymentView,
  ReviewView,
  TaskSnapshot,
} from "./api/types";
import {
  BudgetPanel,
  AgentPanel,
  CatalogCards,
  LessonCards,
  LessonDetails,
  PaymentDetails,
  PaymentTable,
  PlanView,
  SessionTasks,
  TaskPanel,
  type TaskTab,
} from "./components/workspace";
import { Badge, Button, EmptyState, Modal } from "./components/ui";
import { scenarios, taskLabels, tones, type Scenario } from "./labels";
import { formatDate, formatTime, formatUsdc, parseUsdc } from "./lib/format";
import { useTaskWorkspace } from "./use-workspace";

type Page = "overview" | "workspace" | "payments" | "lessons" | "catalog";
type Dialog =
  | "create"
  | "authorize"
  | "review"
  | "payment"
  | "lesson"
  | "connect"
  | "open"
  | "cancel"
  | "revoke"
  | "help"
  | null;
const navigation = [
  { id: "overview", label: "概览", icon: House },
  { id: "workspace", label: "任务工作台", icon: Stack },
  { id: "payments", label: "付款记录", icon: Wallet },
  { id: "lessons", label: "经验库", icon: Brain },
  { id: "catalog", label: "可信目录", icon: Database },
] as const;
const pageMeta: Record<Page, [string, string]> = {
  overview: ["运行概览", "你的目标、Agent 的行动与每一笔付款，都在这里。"],
  workspace: ["任务工作台", "从原始目标出发，沿着授权边界执行。"],
  payments: ["付款记录", "逐笔查看判定、授权、来源与结算回执。"],
  lessons: ["防御经验库", "经过验证的经验，带着证据进入下一次任务。"],
  catalog: ["可信资源目录", "任务可以引用的商家、工具与路由。"],
};
const initialTaskId = () => {
  const id = new URLSearchParams(window.location.search).get("task");
  return id && /^[A-Za-z][A-Za-z0-9_-]{2,63}$/.test(id) ? id : null;
};

export default function App() {
  const [client, setClient] = useState(
    () => new MotionClient({ baseUrl: import.meta.env.VITE_API_BASE || "" }),
  );
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [mode, setMode] = useState<ExecutionMode | null>(null);
  const [apiLoading, setApiLoading] = useState(true);
  const [apiError, setApiError] = useState("");
  const [page, setPage] = useState<Page>(
    initialTaskId() ? "workspace" : "overview",
  );
  const [selectedId, setSelectedId] = useState<string | null>(initialTaskId);
  const [sessionTasks, setSessionTasks] = useState<TaskSnapshot[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [taskTab, setTaskTab] = useState<TaskTab>("events");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(
    () => window.matchMedia("(max-width: 760px)").matches,
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [toast, setToast] = useState("");
  const [selectedPayment, setSelectedPayment] = useState<PaymentView | null>(
    null,
  );
  const [selectedReview, setSelectedReview] = useState<ReviewView | null>(null);
  const [selectedLesson, setSelectedLesson] = useState<LessonView | null>(null);
  const [evidence, setEvidence] = useState<EvidenceSummary[]>([]);
  const [evidenceError, setEvidenceError] = useState("");
  const [consent, setConsent] = useState(false);
  const [search, setSearch] = useState("");
  const [paymentFilter, setPaymentFilter] = useState("all");
  const [lessonFilter, setLessonFilter] = useState("all");
  const [clock, setClock] = useState(Date.now());
  const [simulatorControls, setSimulatorControls] = useState(() =>
    initialSimulatorControls(import.meta.env.VITE_SIMULATOR_CONTROLS),
  );
  const [connectionDraft, setConnectionDraft] = useState({
    baseUrl: import.meta.env.VITE_API_BASE || "",
    token: "",
    simulatorControls: initialSimulatorControls(
      import.meta.env.VITE_SIMULATOR_CONTROLS,
    ),
  });
  const [openTaskId, setOpenTaskId] = useState("");
  const [form, setForm] = useState({
    goal: "",
    budget: "1",
    maxPaidCalls: "3",
    hours: "1",
    vendorIds: [] as string[],
    scenario: "normal" as Scenario,
  });
  const keys = useRef(new Map<string, string>());
  const evidenceGeneration = useRef(0);
  const createRequest = useRef<{
    fingerprint: string;
    body: CreateTask;
    key: string;
  } | null>(null);
  const workspace = useTaskWorkspace(client, selectedId);
  const { task, plan, payments, reviews, lessons, events, refresh, taskResult, resultError, resultPending } = workspace;

  useEffect(() => {
    let live = true;
    setApiLoading(true);
    setCatalog(null);
    setMode(null);
    setApiError("");
    void client
      .catalog()
      .then((value) => {
        if (!live) return;
        setCatalog(value);
        setMode(client.executionMode);
      })
      .catch((cause: Error) => {
        if (live) setApiError(errorText(cause));
      })
      .finally(() => {
        if (live) setApiLoading(false);
      });
    return () => {
      live = false;
    };
  }, [client]);

  useEffect(() => {
    if (!task) return;
    setSessionTasks((previous) => [
      task,
      ...previous.filter((item) => item.taskId !== task.taskId),
    ]);
  }, [task]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4200);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => {
      setMobileViewport(media.matches);
      if (!media.matches) setMobileOpen(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setDialog("open");
        setActionError("");
      }
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const idempotency = useCallback((identity: string) => {
    let key = keys.current.get(identity);
    if (!key) {
      key = `ui-${crypto.randomUUID()}`;
      keys.current.set(identity, key);
    }
    return key;
  }, []);

  function selectTask(id: string) {
    setSelectedId(id);
    setPage("workspace");
    setTaskTab("events");
    setActionError("");
    const url = new URL(window.location.href);
    url.searchParams.set("task", id);
    window.history.replaceState({}, "", url);
  }
  function showDialog(value: Dialog) {
    setActionError("");
    setConsent(false);
    setDialog(value);
  }
  function closeDialog() {
    if (!busy) {
      ++evidenceGeneration.current;
      setDialog(null);
      setActionError("");
      setConnectionDraft((current) => ({ ...current, token: "" }));
    }
  }

  async function reportError(cause: unknown) {
    const message = errorText(cause);
    setActionError(message);
    const successfulHttpButInvalidResponse =
      cause instanceof ApiError && cause.status >= 200 && cause.status < 300;
    if (
      cause instanceof ApiError &&
      ([412, 409].includes(cause.status) || successfulHttpButInvalidResponse)
    ) {
      let refreshed = false;
      if (selectedId) {
        try {
          refreshed = Boolean(await refresh());
        } catch {
          /* The existing snapshot remains stale until an explicit refresh succeeds. */
        }
      }
      setDialog(null);
      setActionError(
        `${message} ${successfulHttpButInvalidResponse ? "服务返回了成功状态，但响应未通过校验；请先核对实际处理结果。" : ""}${refreshed ? "已重新读取快照。请检查最新状态，再重新确认。" : "最新快照读取失败，请先刷新并核对状态。"}刚才的操作没有自动重试。`,
      );
    }
  }
  async function perform(
    action: () => Promise<unknown>,
    success: string,
    close = true,
  ) {
    if (busy) return;
    setBusy(true);
    setActionError("");
    let submitted = false;
    try {
      await action();
      submitted = true;
      await refresh();
      if (close) setDialog(null);
      if (success) setToast(success);
    } catch (cause) {
      if (submitted) {
        setDialog(null);
        setActionError(
          "操作已受理，但最新状态同步失败。请刷新权威快照，核对结果后再继续。刚才的操作没有重复提交。",
        );
      } else {
        workspace.invalidate();
        await reportError(cause);
      }
    } finally {
      setBusy(false);
    }
  }
  async function refreshState() {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      const snapshot = await refresh();
      if (snapshot) setToast("已刷新权威快照");
    } catch {
      setActionError(
        "最新快照读取失败，资金操作已暂停。请检查连接并再次刷新。",
      );
    } finally {
      setBusy(false);
    }
  }

  function newTask(demo = false, initialGoal = "") {
    setForm({
      goal: demo
        ? "比较指定供应商的交付条件，购买完成比较所需的资料。"
        : initialGoal,
      budget: "1",
      maxPaidCalls: "3",
      hours: "1",
      vendorIds: catalog?.vendors[0] ? [catalog.vendors[0].vendorId] : [],
      scenario: demo ? "review" : "normal",
    });
    createRequest.current = null;
    showDialog("create");
  }
  async function submitCreate(event?: FormEvent) {
    event?.preventDefault();
    if (busy || !catalog || !mode) return;
    const budget = parseUsdc(form.budget);
    if (!form.goal.trim() || form.goal.trim().length > 2000) {
      setActionError("请填写 1–2000 字的原始任务目标。");
      return;
    }
    if (!budget || BigInt(budget) <= 0n || budget.length > 30) {
      setActionError("请输入有效的正数预算，最多 6 位小数、30 位原子单位。");
      return;
    }
    const calls = Number(form.maxPaidCalls);
    if (!Number.isInteger(calls) || calls < 1 || calls > 20) {
      setActionError("付费次数必须为 1–20 之间的整数。");
      return;
    }
    if (!form.vendorIds.length) {
      setActionError("请至少选择一个可信目录中的商家。");
      return;
    }
    const fingerprint = JSON.stringify({ ...form, budget });
    if (
      !createRequest.current ||
      createRequest.current.fingerprint !== fingerprint
    )
      createRequest.current = {
        fingerprint,
        key: `ui-create-${crypto.randomUUID()}`,
        body: {
          goal: form.goal.trim(),
          allowedVendorIds: form.vendorIds,
          budgetAtomic: budget,
          maxPaidCalls: calls,
          expiresAt: new Date(
            Date.now() + Number(form.hours) * 3600000,
          ).toISOString(),
        },
      };
    const request = createRequest.current;
    setBusy(true);
    setActionError("");
    try {
      const created = await client.createTask(
        request.body,
        request.key,
        scenarioForConnection(mode, simulatorControls, form.scenario),
      );
      selectTask(created.taskId);
      setSessionTasks((previous) => [
        created,
        ...previous.filter((item) => item.taskId !== created.taskId),
      ]);
      setDialog(null);
      setTaskTab("plan");
      await client.plan(
        created.taskId,
        created.etag,
        idempotency(`plan:${created.taskId}:${created.etag}`),
      );
      setToast("任务已创建，正在生成资源计划");
    } catch (cause) {
      await reportError(cause);
    } finally {
      setBusy(false);
    }
  }

  function authorize() {
    if (!task || !plan || !consent || !workspace.fresh) return;
    void perform(
      () =>
        client.authorize(
          task.taskId,
          task.etag,
          plan.planHash,
          idempotency(`authorize:${task.taskId}:${task.etag}:${plan.planHash}`),
        ),
      "资源计划与授权已冻结",
    );
  }
  function runTask() {
    if (!task?.authorization || !workspace.fresh) return;
    void perform(
      () =>
        client.run(
          task.taskId,
          task.etag,
          task.authorization!.version,
          idempotency(`run:${task.taskId}:${task.etag}`),
        ),
      "任务已开始执行",
    );
  }
  function resolveReview(choice: "APPROVE" | "REJECT") {
    if (
      !task ||
      !selectedReview ||
      !reviewActionAllowed ||
      (choice === "APPROVE" && !consent)
    )
      return;
    if (Date.parse(selectedReview.expiresAt) <= Date.now()) {
      setClock(Date.now());
      setActionError("此复核已超过有效期，请刷新并核对最新状态。");
      return;
    }
    void perform(
      () =>
        client.resolveReview(
          task.taskId,
          selectedReview,
          choice,
          idempotency(
            `review:${selectedReview.reviewId}:${selectedReview.etag}:${choice}`,
          ),
        ),
      choice === "APPROVE" ? "已提交此准确付款快照的批准" : "已拒绝此笔付款",
    );
  }
  const reviewPayment = payments.find(
    (payment) => payment.paymentId === selectedReview?.paymentId,
  );
  const reviewActionAllowed = Boolean(
    workspace.fresh &&
    task &&
    selectedReview &&
    selectedReview.status === "PENDING" &&
    reviews.some(
      (item) =>
        item.reviewId === selectedReview.reviewId &&
        item.etag === selectedReview.etag &&
        item.status === "PENDING",
    ) &&
    task.status === "PAUSED_REVIEW" &&
    task.authorization?.status === "ACTIVE" &&
    selectedReview.authorizationVersion === task.authorization.version &&
    selectedReview.planHash === task.planHash &&
    Date.parse(selectedReview.expiresAt) > clock &&
    reviewPayment &&
    reviewPayment.decision.hardGate !== "BLOCK" &&
    reviewPayment.requestHash === selectedReview.requestHash &&
    reviewPayment.offerHash === selectedReview.offerHash,
  );

  async function viewPayment(payment: PaymentView) {
    const ticket = ++evidenceGeneration.current;
    setSelectedPayment(payment);
    setEvidence([]);
    setEvidenceError("");
    showDialog("payment");
    try {
      const values = await Promise.all(
        payment.decision.evidenceIds.map((id) =>
          client.evidence(payment.taskId, id),
        ),
      );
      if (ticket === evidenceGeneration.current) setEvidence(values);
    } catch (cause) {
      if (ticket === evidenceGeneration.current)
        setEvidenceError(errorText(cause));
    }
  }
  function exportEvidence() {
    if (!task) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      executionMode: task.executionMode,
      note:
        task.executionMode === "MOCK"
          ? "付款为 MOCK 沙箱记录；模型与资料来源见结构化执行记录，不代表链上结算、防护效果或学习收益。"
          : "仅导出公共 API 的任务快照与连接期间事件。",
      task,
      taskResult,
      plan,
      payments,
      reviews,
      lessons,
      events,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `motion-${task.taskId}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setToast("公共任务记录已导出");
  }
  function connect(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const baseUrl = connectionDraft.baseUrl.trim().replace(/\/$/, "");
    if (baseUrl) {
      try {
        const parsed = new URL(baseUrl);
        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          parsed.search ||
          parsed.hash ||
          parsed.pathname !== "/"
        )
          throw new Error();
      } catch {
        setActionError(
          "API 地址请填写无账号、查询参数和路径的 HTTP(S) origin，例如 http://127.0.0.1:4010。",
        );
        return;
      }
    }
    setClient(
      new MotionClient({
        baseUrl,
        token: connectionDraft.token.trim() || undefined,
      }),
    );
    ++evidenceGeneration.current;
    setSelectedPayment(null);
    setSelectedReview(null);
    setSelectedLesson(null);
    setEvidence([]);
    setEvidenceError("");
    setSelectedId(null);
    setSessionTasks([]);
    setDialog(null);
    setActionError("");
    keys.current.clear();
    setSimulatorControls(connectionDraft.simulatorControls);
    setConnectionDraft({
      baseUrl,
      token: "",
      simulatorControls: connectionDraft.simulatorControls,
    });
    setToast("连接已更新，会话凭据仅保存在内存中");
    const url = new URL(window.location.href);
    url.searchParams.delete("task");
    window.history.replaceState({}, "", url);
  }
  const filteredPayments = useMemo(
    () =>
      payments.filter(
        (payment) =>
          (paymentFilter === "all" ||
            payment.decision.type === paymentFilter ||
            (paymentFilter === "UNKNOWN" && payment.state === "UNKNOWN")) &&
          `${payment.vendorId} ${payment.paymentId} ${resourceLabelsForSearch(payment.resourceKind)}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [payments, paymentFilter, search],
  );
  const filteredLessons = lessons.filter(
    (lesson) => lessonFilter === "all" || lesson.status === lessonFilter,
  );
  const connected = Boolean(catalog && mode);
  const displayedError =
    actionError || (workspace.error ? errorText(workspace.error) : "");
  const [heading, subtitle] = pageMeta[page];

  return (
    <div className="app-shell">
      <aside
        className={`sidebar ${mobileOpen ? "is-open" : ""}`}
        aria-label="主导航"
        aria-hidden={mobileViewport && !mobileOpen}
        inert={mobileViewport && !mobileOpen}
      >
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            setPage("overview");
            setMobileOpen(false);
          }}
          aria-label="Motion Guard 首页"
        >
          <span className="brand-mark">
            <ShieldCheck size={37} weight="duotone" />
          </span>
          <span>
            <span className="brand-name">
              motion<span>guard</span>
            </span>
            <span className="brand-caption" style={{ display: "block" }}>
              AGENT PAYMENT FIREWALL
            </span>
          </span>
        </a>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              className={`nav-item ${page === id ? "active" : ""}`}
              key={id}
              aria-current={page === id ? "page" : undefined}
              onClick={() => {
                setPage(id);
                setMobileOpen(false);
                setSearch("");
              }}
            >
              <Icon size={18} weight={page === id ? "duotone" : "regular"} />
              {label}
              {id === "workspace" && task?.pendingReviewCount ? (
                <span className="nav-count">{task.pendingReviewCount}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <button className="nav-item" onClick={() => showDialog("help")}>
          <Question size={18} />
          使用指南
          <ArrowRight size={13} style={{ marginLeft: "auto" }} />
        </button>
        <div className="environment-card">
          <div className="environment-title">
            <span className="dot" style={{ color: "#b4cf8c" }} />
            {mode === "MOCK"
              ? "付款沙箱 · MOCK"
              : mode === "TESTNET"
                ? "Base Sepolia 测试网"
                : "等待 API 连接"}
          </div>
          <p>
            {mode === "MOCK" ? (
              <>
                MOCK · 没有真实资金动作
                <br />
                {simulatorControls ? "本地开发场景已启用" : "模型状态见结构化执行报告"}
              </>
            ) : mode === "TESTNET" ? (
              <>
                测试资产 · 以回执核验为准
                <br />
                契约 v{CONTRACT_VERSION}
              </>
            ) : (
              <>
                启动后端或配置公共 API
                <br />
                契约 v{CONTRACT_VERSION}
              </>
            )}
          </p>
        </div>
        <div className="sidebar-footer">
          <span className="avatar">OP</span>
          <div>
            <strong>Operator workspace</strong>
            <small>
              {mode === "MOCK"
                ? task?.authMode === "OPERATOR_SESSION"
                  ? "MOCK · 会话已认证"
                  : "MOCK · 身份未验证"
                : mode === "TESTNET"
                  ? "Operator session"
                  : "本地工作区"}
            </small>
          </div>
          <button aria-label="连接设置" onClick={() => showDialog("connect")}>
            <SlidersHorizontal size={17} />
          </button>
        </div>
      </aside>
      {mobileOpen && (
        <button
          className="mobile-backdrop"
          aria-label="关闭导航"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <div className="content-shell" inert={mobileViewport && mobileOpen}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setMobileOpen(true)}
            >
              <List size={20} />
            </button>
            <span>工作空间</span>
            <CaretRight size={10} />
            <strong>
              {navigation.find((item) => item.id === page)?.label}
            </strong>
          </div>
          <div className="topbar-tools">
            <span className="connection-label">
              <span
                className="dot"
                style={{ color: connected ? "#9cb97c" : "#c4ad76" }}
              />
              {connected
                ? "公共 API 已连接"
                : apiLoading
                  ? "正在连接…"
                  : "API 未连接"}
            </span>
            <span className="topbar-divider" />
            <button
              className="icon-button"
              aria-label="打开任务"
              title="打开任务 Ctrl+K"
              onClick={() => showDialog("open")}
            >
              <MagnifyingGlass size={17} />
            </button>
            <button
              className="icon-button"
              aria-label="查看待复核请求"
              onClick={() => {
                const pending = reviews.find(
                  (item) => item.status === "PENDING",
                );
                if (pending) {
                  setSelectedReview(pending);
                  showDialog("review");
                } else setToast("当前任务没有待处理的复核请求");
              }}
            >
              <Bell size={17} />
              {task?.pendingReviewCount ? (
                <i className="notification-dot" />
              ) : null}
            </button>
            <button
              className="avatar topbar-avatar"
              aria-label="配置操作员会话"
              onClick={() => showDialog("connect")}
            >
              OP
            </button>
          </div>
        </header>
        <div className="mock-banner" role="status">
          <span>
            <strong>{mode || "OFFLINE"}</strong>
            {mode === "MOCK"
              ? "付款模式为 MOCK，付款授权与结算使用沙箱，不会发生链上付款。模型与资料来源见结构化执行报告。"
              : mode === "TESTNET"
                ? "当前为 Base Sepolia 测试网。授权与结算状态分别显示，请以独立核验回执为准。"
                : "尚未确认执行环境。请启动后端或连接公共 API。"}
          </span>
          <button onClick={() => showDialog("connect")}>
            连接设置 <ArrowRight size={11} />
          </button>
        </div>
        <main className="workspace">
          <div className="page-heading">
            <div>
              <h1>{heading}</h1>
              <p>{subtitle}</p>
            </div>
            <div className="heading-actions">
              <span className="date-label">
                <CalendarBlank size={13} />
                {formatDate(new Date(clock).toISOString())}
              </span>
              <Button variant="ghost" onClick={() => showDialog("open")}>
                <MagnifyingGlass size={13} />
                打开任务
              </Button>
              <Button disabled={!connected || busy} onClick={() => newTask()}>
                <Plus size={14} />
                新建任务
              </Button>
            </div>
          </div>
          {apiError && (
            <div className="error-banner" role="alert">
              <WarningCircle size={17} />
              <div>
                无法连接公共 API。{apiError}
                <br />
                <span>
                  请检查后端服务，或在连接设置中填写公共 API 地址。
                </span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => showDialog("connect")}
              >
                配置连接
              </Button>
            </div>
          )}
          {displayedError && (
            <div className="error-banner" role="alert">
              <WarningCircle size={16} />
              <span>{displayedError}</span>
              <button
                className="icon-button"
                aria-label="关闭提示"
                onClick={() => setActionError("")}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {(page === "overview" || page === "workspace") && (
            <>
              {(page === "overview" || !task) && (
                <OverviewHero
                  connected={connected}
                  busy={busy}
                  mode={mode}
                  simulatorControls={simulatorControls}
                  onNew={(goal) => newTask(false, goal)}
                  onDemo={() => newTask(true)}
                  onConnect={() => showDialog("connect")}
                />
              )}
              {task && (
                <div className="stats-grid">
                  <Stat
                    label="本会话任务"
                    value={String(sessionTasks.length).padStart(2, "0")}
                    icon={<Stack size={19} />}
                    note="仅本次打开或创建的任务"
                  />
                  <Stat
                    label="等待人工复核"
                    value={String(task?.pendingReviewCount ?? 0).padStart(
                      2,
                      "0",
                    )}
                    icon={<ShieldWarning size={19} />}
                    note={
                      task?.pendingReviewCount
                        ? "付款暂停，等待你的决定"
                        : "当前任务没有待办请求"
                    }
                    attention={Boolean(task?.pendingReviewCount)}
                  />
                  <Stat
                    label={mode === "MOCK" ? "模拟资金占用" : "任务资金占用"}
                    value={
                      task
                        ? formatUsdc(
                            (
                              BigInt(task.budget.settledAtomic) +
                              BigInt(task.budget.reservedAtomic) +
                              BigInt(task.budget.outstandingAtomic)
                            ).toString(),
                          )
                        : "0"
                    }
                    unit="USDC"
                    icon={<Wallet size={19} />}
                    note={
                      mode === "MOCK"
                        ? "模拟结算 + 预占 + 待确认"
                        : "结算 + 预占 + 待确认"
                    }
                  />
                  <Stat
                    label="当前任务经验"
                    value={String(lessons.length).padStart(2, "0")}
                    icon={<Brain size={19} />}
                    note={
                      task
                        ? `版本 ${task.activeMemoryVersion}`
                        : "验证后晋升，权限不扩展"
                    }
                  />
                </div>
              )}
              {page === "overview" ? (
                <div className="overview-sessions">
                  <SessionTasks
                    tasks={sessionTasks}
                    selectedId={selectedId}
                    onSelect={selectTask}
                  />
                </div>
              ) : workspace.loading ? (
                <section className="panel">
                  <div className="loading-block">
                    <CircleNotch className="spinner" size={20} />
                    正在读取任务快照…
                  </div>
                </section>
              ) : task ? (
                <div className="main-grid">
                  <div className="main-column">
                    <TaskPanel
                      task={task}
                      result={taskResult}
                      resultError={resultError}
                      resultPending={resultPending}
                      plan={plan}
                      payments={payments}
                      reviews={reviews}
                      lessons={lessons}
                      events={events}
                      catalog={catalog}
                      tab={taskTab}
                      setTab={setTaskTab}
                      busy={busy}
                      stale={!workspace.fresh}
                      connection={workspace.connection}
                      onPlan={() =>
                        void perform(
                          () =>
                            client.plan(
                              task.taskId,
                              task.etag,
                              idempotency(`plan:${task.taskId}:${task.etag}`),
                            ),
                          "正在生成资源计划",
                          false,
                        )
                      }
                      onAuthorize={() => showDialog("authorize")}
                      onRun={runTask}
                      onReview={(review) => {
                        setSelectedReview(review);
                        showDialog("review");
                      }}
                      onPayment={(payment) => void viewPayment(payment)}
                      onLesson={(lesson) => {
                        setSelectedLesson(lesson);
                        showDialog("lesson");
                      }}
                      onCancel={() => showDialog("cancel")}
                      onRevoke={() => showDialog("revoke")}
                      onRefresh={() => void refreshState()}
                    />
                    <TaskEvidence client={client} task={task} events={events} evidenceIds={taskResult?.evidenceIds ?? []} />
                    <AgentPanel task={task} result={taskResult} />
                  </div>
                  <aside className="aside-column" aria-label="任务状态">
                    <BudgetPanel
                      budget={task.budget}
                      mode={task.executionMode}
                    />

                    <div className="note-card">
                      <h3>
                        <Lock size={14} />
                        授权边界始终有效
                      </h3>
                      <p>
                        复核只批准准确的计划内付款。需要更改商家、资源或预算时，创建新任务并重新确认计划。
                      </p>
                    </div>
                    <Button
                      className="button--wide"
                      variant="secondary"
                      onClick={exportEvidence}
                    >
                      <DownloadSimple size={13} />
                      导出公共任务记录
                    </Button>
                  </aside>
                </div>
              ) : null}
            </>
          )}
          {page === "payments" && (
            <>
              <div className="section-toolbar">
                <div className="segmented" aria-label="筛选付款">
                  {[
                    ["all", "全部"],
                    ["ALLOW", "允许"],
                    ["REVIEW", "待复核"],
                    ["BLOCK", "已拒绝"],
                    ["UNKNOWN", "结算未知"],
                  ].map(([value, label]) => (
                    <button
                      className={paymentFilter === value ? "active" : ""}
                      onClick={() => setPaymentFilter(value)}
                      key={value}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="search-field">
                  <MagnifyingGlass size={13} />
                  <input
                    aria-label="搜索付款"
                    placeholder="搜索商家、付款 ID…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <div className="panel-title">
                    <Wallet size={16} />
                    <h2>当前任务付款</h2>
                  </div>
                  <span className="event-count">
                    {filteredPayments.length} 笔 · {mode || "OFFLINE"}
                  </span>
                </div>
                <PaymentTable
                  payments={filteredPayments}
                  catalog={catalog}
                  onSelect={(payment) => void viewPayment(payment)}
                  completedWithoutPayments={task?.status === "COMPLETED" && payments.length === 0}
                />
              </section>
              <p className="form-hint" style={{ marginTop: 15 }}>
                显示当前打开任务的公开付款记录。通过任务 ID 可查看其他任务。
              </p>
            </>
          )}
          {page === "lessons" && (
            <>
              <div className="section-toolbar">
                <div className="segmented" aria-label="筛选经验">
                  {[
                    ["all", "全部经验"],
                    ["ACTIVE", "已晋升"],
                    ["QUARANTINED", "隔离验证"],
                    ["REVOKED", "已撤回"],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      className={lessonFilter === value ? "active" : ""}
                      onClick={() => setLessonFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="toolbar-caption">
                  {task?.activeMemoryVersion || "暂无经验版本"} ·
                  当前任务只读快照
                </span>
              </div>
              {mode === "MOCK" && (
                <div className="preview-intro">
                  <Info size={15} />
                  <span>
                    MOCK · 沙箱 oracle
                    标注的经验闭环。这里的示例不构成真实学习实验或收益证据。
                  </span>
                </div>
              )}
              <LessonCards
                lessons={filteredLessons}
                mock={mode === "MOCK"}
                onSelect={(lesson) => {
                  setSelectedLesson(lesson);
                  showDialog("lesson");
                }}
              />
            </>
          )}
          {page === "catalog" && (
            <>
              <div className="section-toolbar">
                <span className="toolbar-caption">
                  {catalog?.catalogVersion || "等待目录"} ·{" "}
                  {catalog?.vendors.length || 0} 个登记商家
                </span>
                <Badge tone="neutral">
                  <Lock size={10} />
                  只读资源目录
                </Badge>
              </div>
              {catalog ? (
                <CatalogCards catalog={catalog} />
              ) : (
                <section className="panel">
                  <EmptyState
                    icon={<Database size={30} />}
                    title={apiLoading ? "正在获取可信目录" : "可信目录尚未连接"}
                    description="连接公共 API 后，才能读取受控商家与资源。"
                    action={
                      <Button
                        variant="secondary"
                        onClick={() => showDialog("connect")}
                      >
                        连接设置
                      </Button>
                    }
                  />
                </section>
              )}
            </>
          )}
          <footer className="workspace-footer">
            <span className="footer-brand">
              MOTION GUARD{" "}
              <span style={{ marginLeft: 8 }}>让每次行动都有据可循。</span>
            </span>
            <div>
              <span
                className="dot"
                style={{ color: "#a3b38a", width: 4, height: 4 }}
              />
              {mode || "OFFLINE"} · 契约 {CONTRACT_VERSION} · Asia/Shanghai
            </div>
          </footer>
        </main>
      </div>

      <Modal
        open={dialog === "create"}
        title="新建任务"
        description="定义原始目标与资金边界，先生成资源计划，再由你确认授权。"
        onClose={closeDialog}
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={busy}>
              取消
            </Button>
            <Button
              type="submit"
              form="create-task"
              disabled={busy || !connected}
            >
              {busy ? (
                <CircleNotch className="spinner" size={13} />
              ) : (
                <Plus size={13} />
              )}
              创建并生成计划
            </Button>
          </>
        }
      >
        <form id="create-task" onSubmit={submitCreate}>
          <div className="form-group">
            <label htmlFor="goal">
              任务目标<span>{form.goal.length}/2000</span>
            </label>
            <textarea
              id="goal"
              className="textarea"
              maxLength={2000}
              required
              placeholder="例如：整理已授权的公开资料，核对关键事实与来源。"
              value={form.goal}
              onChange={(event) =>
                setForm((value) => ({ ...value, goal: event.target.value }))
              }
            />
            <p className="form-hint">
              写明需要完成的事情。外部网页、工具或 Agent
              的建议不能改变这个目标。
            </p>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="budget">总预算 (USDC)</label>
              <input
                className="input"
                id="budget"
                inputMode="decimal"
                required
                value={form.budget}
                onChange={(event) =>
                  setForm((value) => ({ ...value, budget: event.target.value }))
                }
              />
            </div>
            <div className="form-group">
              <label htmlFor="calls">最多付费次数</label>
              <input
                className="input"
                id="calls"
                type="number"
                min={1}
                max={20}
                step={1}
                required
                value={form.maxPaidCalls}
                onChange={(event) =>
                  setForm((value) => ({
                    ...value,
                    maxPaidCalls: event.target.value,
                  }))
                }
              />
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="duration">授权有效期</label>
            <select
              id="duration"
              className="select"
              value={form.hours}
              onChange={(event) =>
                setForm((value) => ({ ...value, hours: event.target.value }))
              }
            >
              <option value="1">1 小时</option>
              <option value="4">4 小时</option>
              <option value="24">24 小时</option>
            </select>
          </div>
          <div className="form-group">
            <span className="field-label">
              允许的资料来源 / 商家<span>{form.vendorIds.length}/3</span>
            </span>
            <div className="form-vendors">
              {catalog?.vendors.map((vendor) => (
                <label className="vendor-choice" key={vendor.vendorId}>
                  <input
                    type="checkbox"
                    checked={form.vendorIds.includes(vendor.vendorId)}
                    onChange={(event) =>
                      setForm((value) => ({
                        ...value,
                        vendorIds: event.target.checked
                          ? [...value.vendorIds, vendor.vendorId]
                          : value.vendorIds.filter(
                              (id) => id !== vendor.vendorId,
                            ),
                      }))
                    }
                  />
                  <div>
                    <strong>{vendor.name}</strong>
                    <small>
                      {vendor.billing?.kind === "FREE_PUBLIC_DATA" ? "免费公开资料 · 无需付款" : `${vendor.resourceKind} · ${vendor.toolId}`}
                    </small>
                  </div>
                </label>
              ))}
            </div>
          </div>
          {mode === "MOCK" && simulatorControls && (
            <div className="form-group">
              <label htmlFor="scenario">
                演示场景<span>仅本地模拟服务</span>
              </label>
              <select
                id="scenario"
                className="select"
                value={form.scenario}
                onChange={(event) =>
                  setForm((value) => ({
                    ...value,
                    scenario: event.target.value as Scenario,
                  }))
                }
              >
                {scenarios.map(([id, label]) => (
                  <option value={id} key={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="form-warning">
            <Lock size={14} />
            <span>
              {mode === "MOCK"
                ? "MOCK：此任务使用沙箱付款授权与模拟结算，不会发生链上付款。"
                : "TESTNET：冻结计划后可能产生真实测试网付款授权。"}{" "}
              计划确认前不会读取外部资料。
            </span>
          </div>
          {actionError && (
            <p className="form-error" role="alert" style={{ marginTop: 15 }}>
              <WarningCircle size={14} />
              {actionError}
            </p>
          )}
        </form>
      </Modal>

      <Modal
        open={dialog === "authorize"}
        title="确认资源计划"
        description="确认后将冻结原始目标、资源清单、预算和授权版本。"
        onClose={closeDialog}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={closeDialog}>
              返回检查
            </Button>
            <Button
              disabled={
                busy ||
                !workspace.fresh ||
                !consent ||
                !task ||
                task.status !== "AWAITING_AUTHORIZATION" ||
                plan?.status !== "DRAFT"
              }
              onClick={authorize}
            >
              <Lock size={13} />
              确认并冻结授权
            </Button>
          </>
        }
      >
        {task && (
          <>
            <div className="detail-notice">
              {task.executionMode} · {task.goal}
            </div>
            <PlanView plan={plan} catalog={catalog} />
            <h3 className="detail-heading">授权范围</h3>
            <dl className="detail-grid">
              <dt>总预算</dt>
              <dd>{formatUsdc(task.budget.limitAtomic)} USDC</dd>
              <dt>允许商家</dt>
              <dd>
                {task.allowedVendorIds
                  .map(
                    (id) =>
                      catalog?.vendors.find((vendor) => vendor.vendorId === id)
                        ?.name ?? id,
                  )
                  .join("、")}
              </dd>
              <dt>任务快照</dt>
              <dd>
                v{task.version} · {task.etag}
              </dd>
            </dl>
            <p className="form-warning" style={{ marginTop: 20 }}>
              需要变更商家、资源或预算时，创建新任务并重新确认。人工复核不能扩展此授权。
            </p>
            <label className="vendor-choice" style={{ marginTop: 18 }}>
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              <span>我已核对资源、单价、次数、总额与有效期</span>
            </label>
          </>
        )}
        {actionError && (
          <p className="form-error" role="alert" style={{ marginTop: 15 }}>
            {actionError}
          </p>
        )}
      </Modal>

      <Modal
        open={dialog === "review"}
        title="复核计划内付款"
        description="批准只对这笔准确的付款快照生效，不能覆盖硬策略或扩展计划。"
        onClose={closeDialog}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy || !reviewActionAllowed}
              onClick={() => resolveReview("REJECT")}
            >
              拒绝付款
            </Button>
            <Button
              disabled={busy || !consent || !reviewActionAllowed}
              onClick={() => resolveReview("APPROVE")}
            >
              <Check size={13} />
              批准这笔计划内付款
            </Button>
          </>
        }
      >
        {selectedReview && (
          <>
            <div className="payment-amount">
              {formatUsdc(selectedReview.amountAtomic)}
              <small>USDC</small>
            </div>
            <div className="detail-notice">
              {task?.executionMode} · {selectedReview.summary}
            </div>
            <dl className="detail-grid">
              <dt>商家</dt>
              <dd>
                {catalog?.vendors.find(
                  (vendor) => vendor.vendorId === selectedReview.vendorId,
                )?.name ?? selectedReview.vendorId}
              </dd>
              <dt>完整收款地址</dt>
              <dd className="mono">{selectedReview.payTo}</dd>
              <dt>授权版本</dt>
              <dd>v{selectedReview.authorizationVersion}</dd>
              <dt>复核期限</dt>
              <dd>
                {formatDate(selectedReview.expiresAt)}{" "}
                {formatTime(selectedReview.expiresAt)}（上海）
              </dd>
              <dt>复核状态</dt>
              <dd>
                {selectedReview.status}
                {Date.parse(selectedReview.expiresAt) <= clock
                  ? " · 已超过有效期"
                  : ""}
              </dd>
              <dt>硬策略</dt>
              <dd>{reviewPayment?.decision.hardGate || "等待读取"}</dd>
              <dt>快照摘要</dt>
              <dd className="mono">{selectedReview.snapshotHash}</dd>
              <dt>请求摘要</dt>
              <dd className="mono">{selectedReview.requestHash}</dd>
              <dt>报价摘要</dt>
              <dd className="mono">{selectedReview.offerHash}</dd>
              <dt>计划摘要</dt>
              <dd className="mono">{selectedReview.planHash}</dd>
            </dl>
            {!reviewActionAllowed && (
              <p className="form-warning" style={{ marginTop: 20 }}>
                此复核已过期、已处理或绑定状态发生变化，不能提交决定。请关闭并刷新权威快照。
              </p>
            )}
            <label className="vendor-choice" style={{ marginTop: 20 }}>
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
                disabled={!reviewActionAllowed}
              />
              <span>我确认这笔准确的计划内采购符合原始任务目标</span>
            </label>
          </>
        )}
        {actionError && (
          <p className="form-error" role="alert" style={{ marginTop: 15 }}>
            {actionError}
          </p>
        )}
      </Modal>

      <Modal
        open={dialog === "payment"}
        title="付款与判定详情"
        description={selectedPayment?.paymentId}
        onClose={closeDialog}
        footer={
          <Button variant="secondary" onClick={closeDialog}>
            关闭
          </Button>
        }
      >
        {selectedPayment && <PaymentDetails payment={selectedPayment} />}
        <h3 className="detail-heading">
          <FileText size={14} />
          脱敏来源证据
        </h3>
        {evidenceError && <p className="form-error">{evidenceError}</p>}
        {evidence.map((item) => (
          <div key={item.evidenceId} style={{ marginBottom: 15 }}>
            <div className="inline-actions" style={{ marginBottom: 8 }}>
              <Badge tone="neutral">{item.sourceKind}</Badge>
              <Badge
                tone={
                  item.trust === "EXTERNAL_UNTRUSTED" ||
                  item.trust === "MODEL_DERIVED"
                    ? "amber"
                    : "green"
                }
              >
                {item.trust}
              </Badge>
            </div>
            <div className="evidence-box">{item.excerpt}</div>
            <p className="form-hint" style={{ marginTop: 8 }}>
              父来源：{item.parentIds.join("、") || "无"}
              <br />
              <span className="mono">{item.parentClosureHash}</span>
            </p>
          </div>
        ))}
        <p className="form-hint">
          证据仅按纯文本显示。转述与摘要保留来源信任级别。
        </p>
      </Modal>
      <Modal
        open={dialog === "lesson"}
        title="防御经验与验证记录"
        description={selectedLesson?.lessonId}
        onClose={closeDialog}
        footer={
          <Button variant="secondary" onClick={closeDialog}>
            关闭
          </Button>
        }
      >
        {selectedLesson && (
          <LessonDetails lesson={selectedLesson} mock={mode === "MOCK"} />
        )}
      </Modal>

      <Modal
        open={dialog === "cancel" || dialog === "revoke"}
        title={dialog === "revoke" ? "撤销任务授权" : "取消任务"}
        description="此操作阻止生效后的新签名，已经产生且可能兑付的授权继续占用预算。"
        onClose={closeDialog}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={closeDialog}>
              继续保留任务
            </Button>
            <Button
              variant="danger"
              disabled={busy || !workspace.fresh || !task}
              onClick={() => {
                if (!task) return;
                const operation = dialog === "revoke" ? "revoke" : "cancel";
                void perform(
                  () =>
                    client[operation](
                      task.taskId,
                      task.etag,
                      idempotency(`${operation}:${task.taskId}:${task.etag}`),
                    ),
                  operation === "revoke"
                    ? "授权已撤销，已产生的待确认占用仍会保留"
                    : "任务已取消，待确认占用仍会保留",
                );
              }}
            >
              确认{dialog === "revoke" ? "撤销授权" : "取消任务"}
            </Button>
          </>
        }
      >
        {task && (
          <>
            <p style={{ fontSize: 12 }}>{task.goal}</p>
            <div className="detail-notice" style={{ marginTop: 18 }}>
              待确认占用：{formatUsdc(task.budget.outstandingAtomic)}{" "}
              USDC。取消或撤销不代表退款，不会自动释放可能兑付的资金。
            </div>
          </>
        )}
        {actionError && (
          <p className="form-error" role="alert">
            {actionError}
          </p>
        )}
      </Modal>

      <Modal
        open={dialog === "connect"}
        title="公共 API 连接"
        description={`连接已实现契约 ${CONTRACT_VERSION} 的服务。操作员会话只保存在内存中。`}
        onClose={closeDialog}
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog}>
              取消
            </Button>
            <Button type="submit" form="connect-api" disabled={busy}>
              <PlugsConnected size={13} />
              应用连接
            </Button>
          </>
        }
      >
        <form id="connect-api" onSubmit={connect}>
          <div className="form-group">
            <label htmlFor="api-origin">
              API 地址<span>留空使用同源 /api 代理</span>
            </label>
            <input
              className="input"
              id="api-origin"
              type="url"
              placeholder="http://127.0.0.1:4010"
              autoComplete="off"
              value={connectionDraft.baseUrl}
              onChange={(event) =>
                setConnectionDraft((current) => ({
                  ...current,
                  baseUrl: event.target.value,
                }))
              }
            />
          </div>
          <div className="form-group">
            <label htmlFor="operator-token">
              Operator session<span>按服务要求填写</span>
            </label>
            <input
              className="input"
              id="operator-token"
              type="password"
              autoComplete="off"
              placeholder="可信入口发放的会话，仅在内存中保存"
              value={connectionDraft.token}
              onChange={(event) =>
                setConnectionDraft((current) => ({
                  ...current,
                  token: event.target.value,
                }))
              }
            />
          </div>
          <label className="vendor-choice connection-profile-choice">
            <input
              type="checkbox"
              checked={connectionDraft.simulatorControls}
              onChange={(event) =>
                setConnectionDraft((current) => ({
                  ...current,
                  simulatorControls: event.target.checked,
                }))
              }
            />
            <div>
              <strong>启用本地开发场景</strong>
              <small>
                仅连接已开启开发场景的本机 MOCK 服务时启用。常规联调与 TESTNET
                保持关闭。
              </small>
            </div>
          </label>
          <div className="form-warning">
            <Lock size={14} />
            <span>
              会话不写入本地存储、地址、日志或导出文件。切换连接会清空本会话任务列表；浏览器刷新后需重新连接。
            </span>
          </div>
          {actionError && (
            <p className="form-error" role="alert" style={{ marginTop: 15 }}>
              {actionError}
            </p>
          )}
        </form>
      </Modal>

      <Modal
        open={dialog === "open"}
        title="打开任务"
        description="使用公共 API 返回的任务 ID。下方只列本会话打开过的任务。"
        onClose={closeDialog}
        footer={
          <Button
            type="submit"
            form="open-task"
            disabled={!openTaskId.trim() || busy || !connected}
          >
            打开任务 <ArrowRight size={12} />
          </Button>
        }
      >
        <form
          id="open-task"
          onSubmit={(event) => {
            event.preventDefault();
            const id = openTaskId.trim();
            if (!/^[A-Za-z][A-Za-z0-9_-]{2,63}$/.test(id)) {
              setActionError("请输入有效的任务 ID。");
              return;
            }
            selectTask(id);
            setDialog(null);
            setOpenTaskId("");
          }}
        >
          <div className="form-group">
            <label htmlFor="task-id">任务 ID</label>
            <input
              id="task-id"
              className="input"
              placeholder="task_…"
              value={openTaskId}
              onChange={(event) => setOpenTaskId(event.target.value)}
            />
          </div>
          {actionError && (
            <p className="form-error" role="alert">
              {actionError}
            </p>
          )}
        </form>
        {sessionTasks.length > 0 && (
          <div className="session-task-picker">
            {sessionTasks.map((item) => (
              <button
                onClick={() => {
                  selectTask(item.taskId);
                  setDialog(null);
                }}
                key={item.taskId}
              >
                <FileText size={16} />
                <div>
                  {item.goal}
                  <small>{item.taskId}</small>
                </div>
                <Badge tone={tones[item.status]}>
                  {taskLabels[item.status]}
                </Badge>
              </button>
            ))}
          </div>
        )}
        <p className="form-hint" style={{ marginTop: 18 }}>
          <Command size={10} /> Ctrl / ⌘ + K 随时打开任务
        </p>
      </Modal>

      <Modal
        open={dialog === "help"}
        title="使用 Motion Guard"
        description="先确定授权，再执行任务；每个决定都有对应记录。"
        onClose={closeDialog}
        footer={
          <Button onClick={closeDialog}>
            开始使用 <ArrowRight size={12} />
          </Button>
        }
      >
        <div className="help-step">
          <span>01</span>
          <div>
            <h3>定义原始任务</h3>
            <p>
              选可信目录商家，设置预算、调用次数和有效期。本地开发场景仅在明确开启的开发服务上使用。
            </p>
          </div>
        </div>
        <div className="help-step">
          <span>02</span>
          <div>
            <h3>确认并冻结资源计划</h3>
            <p>
              逐项检查工具、路由、单价和次数。确认前不读取外部资料；确认后不可扩大权限。
            </p>
          </div>
        </div>
        <div className="help-step">
          <span>03</span>
          <div>
            <h3>观察执行，处理准确复核</h3>
            <p>
              查看事件轨迹、付款与来源。复核只能批准准确的计划内请求，无法覆盖硬拒绝。
            </p>
          </div>
        </div>
        <div className="help-step">
          <span>04</span>
          <div>
            <h3>核对回执与经验</h3>
            <p>未知结算保持占额。经验只读展示验证记录，不自动增加任务权限。</p>
          </div>
        </div>
        <div className="detail-notice">
          MOCK 描述付款模式，后端可以独立调用模型 API。模型执行、沙箱资金与测试网结算分别核对。
        </div>
      </Modal>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle size={15} />
          {toast}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  icon,
  note,
  attention = false,
}: {
  label: string;
  value: string;
  unit?: string;
  icon: React.ReactNode;
  note: string;
  attention?: boolean;
}) {
  return (
    <section className={`stat-card ${attention ? "attention" : ""}`}>
      <div className="stat-label">
        <span>{label}</span>
        {icon}
      </div>
      <div className="stat-value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      <p>
        {attention ? (
          <span className="dot" style={{ width: 4, height: 4 }} />
        ) : null}
        {note}
      </p>
    </section>
  );
}
function errorText(cause: unknown): string {
  if (cause instanceof ApiError)
    return `${cause.message}（${cause.code}${cause.requestId ? ` · ${cause.requestId}` : ""}）`;
  if (cause instanceof TypeError)
    return "网络连接失败，请检查 API 地址与服务状态。";
  return cause instanceof Error
    ? cause.message
    : "请求失败，请检查连接后重试。";
}
function resourceLabelsForSearch(kind: string) {
  return (
    (
      {
        DOCUMENT: "资料采购",
        MARKET_DATA: "市场数据",
        ANALYSIS: "分析服务",
      } as Record<string, string>
    )[kind] || kind
  );
}
