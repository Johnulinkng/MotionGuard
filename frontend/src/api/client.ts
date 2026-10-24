import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import contract from "../../vendor/contract/openapi.json";
import { CONTRACT_VERSION } from "./types";
import type {
  ApiErrorPayload,
  Asset,
  AuthorizeTask,
  AuthorizationView,
  BudgetView,
  Catalog,
  CreateTask,
  DecisionView,
  EmptyMutation,
  EventEnvelope,
  EvidenceSummary,
  ExecutionMode,
  LessonList,
  LessonView,
  PaymentList,
  PaymentView,
  ReceiptView,
  ResolveReview,
  ResolveReviewResult,
  ResourcePlan,
  ResourcePlanItem,
  ReviewList,
  ReviewView,
  RunTask,
  TaskSnapshot,
  TaskResult,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly details?: ApiErrorPayload["error"]["details"];

  constructor(
    status: number,
    code: string,
    requestId: string,
    message: string,
    details?: ApiErrorPayload["error"]["details"],
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

interface SchemaMap {
  ApiError: ApiErrorPayload;
  Asset: Asset;
  Catalog: Catalog;
  CreateTask: CreateTask;
  BudgetView: BudgetView;
  ResourcePlanItem: ResourcePlanItem;
  ResourcePlan: ResourcePlan;
  AuthorizationView: AuthorizationView;
  TaskSnapshot: TaskSnapshot;
  TaskResult: TaskResult;
  AuthorizeTask: AuthorizeTask;
  RunTask: RunTask;
  EmptyMutation: EmptyMutation;
  EvidenceSummary: EvidenceSummary;
  DecisionView: DecisionView;
  ReceiptView: ReceiptView;
  PaymentView: PaymentView;
  PaymentList: PaymentList;
  ReviewView: ReviewView;
  ReviewList: ReviewList;
  ResolveReview: ResolveReview;
  ResolveReviewResult: ResolveReviewResult;
  LessonView: LessonView;
  LessonList: LessonList;
  EventEnvelope: EventEnvelope;
}

const ajv = new Ajv2020({ strict: false, allErrors: false });
addFormats(ajv);
ajv.addSchema({ $id: "motion-contract", components: contract.components });
const schemaValidators = new Map<
  keyof SchemaMap,
  ReturnType<typeof ajv.compile>
>();
const strongEtag = /^"[A-Za-z0-9_:-]+"$/;
const resourceId = /^[A-Za-z][A-Za-z0-9_-]{2,63}$/;
const idempotencyKey = /^[A-Za-z0-9._:-]{8,128}$/;

function invalidResponse(status: number, message: string): ApiError {
  return new ApiError(
    status,
    "INVALID_API_RESPONSE",
    "client_response",
    message,
  );
}

function validSchema(name: keyof SchemaMap, payload: unknown): boolean {
  let validate = schemaValidators.get(name);
  if (!validate) {
    validate = ajv.compile({
      $ref: `motion-contract#/components/schemas/${name}`,
    });
    schemaValidators.set(name, validate);
  }
  return Boolean(validate(payload));
}

/** Runtime validation uses only the published local snapshot, including nullable fields and enums. */
export function validatePublicView<N extends keyof SchemaMap>(
  name: N,
  payload: unknown,
  status = 200,
): SchemaMap[N] {
  if (!validSchema(name, payload))
    throw invalidResponse(status, `响应不符合锁定的 ${name} 契约。`);
  if (name === "TaskResult") {
    const result = payload as TaskResult;
    if (result.sources.some(source => !result.evidenceIds.includes(source.evidenceId)))
      throw invalidResponse(status, "结果的来源引用不在公开证据列表中。");
  }
  return payload as SchemaMap[N];
}

function assertMode(
  payload: unknown,
  mode: ExecutionMode,
  status: number,
): void {
  if (!payload || typeof payload !== "object") return;
  if (Array.isArray(payload)) {
    payload.forEach((item) => assertMode(item, mode, status));
    return;
  }
  const value = payload as Record<string, unknown>;
  if ("executionMode" in value && value.executionMode !== mode) {
    throw invalidResponse(status, "响应正文与执行模式标头不一致。");
  }
  if ("paymentMode" in value && value.paymentMode !== mode)
    throw invalidResponse(status, "结果的付款模式与执行模式标头不一致。");
  // Authentication is independent of simulated execution; TESTNET still requires a session.
  if (
    mode === "TESTNET" &&
    "authMode" in value &&
    value.authMode !== "OPERATOR_SESSION"
  ) {
    throw invalidResponse(status, "身份模式与执行模式不一致。");
  }
  Object.values(value).forEach((child) => assertMode(child, mode, status));
}

function pathId(id: string): string {
  if (!resourceId.test(id))
    throw new ApiError(
      0,
      "INVALID_RESOURCE_ID",
      "client_request",
      "资源标识无效。",
    );
  return encodeURIComponent(id);
}

function requestKey(key?: string): string {
  const value = key ?? `motion:${crypto.randomUUID()}`;
  if (!idempotencyKey.test(value))
    throw new ApiError(
      0,
      "INVALID_IDEMPOTENCY_KEY",
      "client_request",
      "幂等键格式无效。",
    );
  return value;
}

export type MockScenario =
  | "normal"
  | "blocked"
  | "review"
  | "unknown"
  | "lesson";
export interface MotionClientOptions {
  baseUrl?: string;
  token?: string;
}

export class MotionClient {
  readonly baseUrl: string;
  readonly #token?: string;
  #executionMode: ExecutionMode | null = null;
  #modeChanged = false;

  constructor({ baseUrl = "", token }: MotionClientOptions = {}) {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    if (trimmed) {
      let url: URL;
      try {
        url = new URL(trimmed);
      } catch {
        throw new ApiError(
          0,
          "INVALID_API_URL",
          "client_request",
          "API 地址须为 HTTP 或 HTTPS 地址。",
        );
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new ApiError(
          0,
          "INVALID_API_URL",
          "client_request",
          "API 地址不能包含凭据、查询参数或片段。",
        );
      }
    }
    if (token && /[\r\n]/.test(token))
      throw new ApiError(
        0,
        "INVALID_SESSION",
        "client_request",
        "会话格式无效。",
      );
    this.baseUrl = trimmed;
    this.#token = token || undefined;
  }

  get executionMode(): ExecutionMode | null {
    return this.#executionMode;
  }

  #headers(accept = "application/json"): Headers {
    const headers = new Headers({
      Accept: accept,
      "X-Contract-Version": CONTRACT_VERSION,
    });
    if (this.#token) headers.set("Authorization", `Bearer ${this.#token}`);
    return headers;
  }

  #responseMode(response: Response): ExecutionMode {
    if (response.headers.get("X-Contract-Version") !== CONTRACT_VERSION) {
      throw invalidResponse(
        response.status,
        "服务端契约版本缺失或不兼容，请检查连接。",
      );
    }
    const mode = response.headers.get("X-Execution-Mode");
    if (mode !== "MOCK" && mode !== "TESTNET")
      throw invalidResponse(response.status, "服务端缺少有效的执行模式标头。");
    this.#checkPinnedMode(mode, response.status);
    return mode;
  }

  #checkPinnedMode(mode: ExecutionMode, status: number): void {
    if (this.#executionMode !== null && this.#executionMode !== mode)
      this.#modeChanged = true;
    if (this.#modeChanged) {
      throw new ApiError(
        status,
        "EXECUTION_MODE_CHANGED",
        "client_response",
        "此连接的执行模式发生变化，已停止使用此连接。请重新连接并核对环境。",
      );
    }
  }

  #confirmMode(mode: ExecutionMode, status: number): void {
    // Concurrent first responses may finish parsing in a different order.
    this.#checkPinnedMode(mode, status);
    this.#executionMode = mode;
  }

  async #json<N extends keyof SchemaMap>(
    response: Response,
    schema: N,
  ): Promise<SchemaMap[N]> {
    const mode = this.#responseMode(response);
    if (
      response.headers
        .get("Content-Type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "application/json"
    ) {
      throw invalidResponse(response.status, "服务端返回了非 JSON 响应。");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw invalidResponse(response.status, "服务端返回了无效 JSON。");
    }
    if (!response.ok) {
      const error = validatePublicView(
        "ApiError",
        payload,
        response.status,
      ).error;
      throw new ApiError(
        response.status,
        error.code,
        error.requestId,
        error.message,
        error.details,
      );
    }
    const data = validatePublicView(schema, payload, response.status);
    assertMode(data, mode, response.status);
    const tag = response.headers.get("ETag");
    if (!tag || !strongEtag.test(tag))
      throw invalidResponse(response.status, "资源响应缺少有效的强 ETag。");
    const target =
      schema === "ResolveReviewResult"
        ? (data as ResolveReviewResult).review
        : data;
    if (
      target &&
      typeof target === "object" &&
      "etag" in target &&
      target.etag !== tag
    ) {
      throw invalidResponse(response.status, "资源正文与 ETag 标头不一致。");
    }
    this.#confirmMode(mode, response.status);
    return data;
  }

  async #get<N extends keyof SchemaMap>(
    path: string,
    schema: N,
    signal?: AbortSignal,
  ): Promise<SchemaMap[N]> {
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, {
      headers: this.#headers(),
      cache: "no-store",
      signal,
    });
    return this.#json(response, schema);
  }

  async #post<N extends keyof SchemaMap>(
    path: string,
    schema: N,
    body: unknown,
    etag?: string,
    key?: string,
    scenario?: MockScenario,
  ): Promise<SchemaMap[N]> {
    if (this.#modeChanged)
      throw new ApiError(
        0,
        "EXECUTION_MODE_CHANGED",
        "client_request",
        "执行环境已变化，请重新连接后再操作。",
      );
    const headers = this.#headers();
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", requestKey(key));
    if (path !== "/tasks") {
      if (!etag || !strongEtag.test(etag))
        throw new ApiError(
          0,
          "INVALID_ETAG",
          "client_request",
          "需要目标资源最新的强 ETag。",
        );
      headers.set("If-Match", etag);
    }
    if (scenario) {
      if (this.#executionMode !== "MOCK")
        throw new ApiError(
          0,
          "MOCK_SCENARIO_NOT_ALLOWED",
          "client_request",
          "只有已验证的 MOCK 连接可以选择模拟场景。",
        );
      headers.set("X-Mock-Scenario", scenario);
    }
    // Never retry a mutation automatically, including 412 and a lost HTTP response.
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
    });
    return this.#json(response, schema);
  }

  catalog(): Promise<Catalog> {
    return this.#get("/catalog", "Catalog");
  }
  createTask(
    body: CreateTask,
    key?: string,
    scenario?: MockScenario,
  ): Promise<TaskSnapshot> {
    if (!validSchema("CreateTask", body))
      return Promise.reject(
        new ApiError(
          0,
          "VALIDATION_ERROR",
          "client_request",
          "请检查目标、商家、预算、次数与有效期。",
        ),
      );
    return this.#post("/tasks", "TaskSnapshot", body, undefined, key, scenario);
  }
  task(id: string, signal?: AbortSignal): Promise<TaskSnapshot> {
    return this.#get(`/tasks/${pathId(id)}`, "TaskSnapshot", signal);
  }
  async taskResult(id: string, signal?: AbortSignal): Promise<TaskResult> {
    const result = await this.#get(`/tasks/${pathId(id)}/result`, "TaskResult", signal);
    if (result.taskId !== id)
      throw invalidResponse(200, "结果不属于当前请求的任务。");
    return result;
  }
  plan(id: string, etag: string, key?: string): Promise<TaskSnapshot> {
    return this.#post(
      `/tasks/${pathId(id)}/plan`,
      "TaskSnapshot",
      {},
      etag,
      key,
    );
  }
  resourcePlan(id: string): Promise<ResourcePlan> {
    return this.#get(`/tasks/${pathId(id)}/resource-plan`, "ResourcePlan");
  }
  authorize(
    id: string,
    etag: string,
    planHash: string,
    key?: string,
  ): Promise<TaskSnapshot> {
    if (!validSchema("AuthorizeTask", { planHash }))
      return Promise.reject(
        new ApiError(
          0,
          "VALIDATION_ERROR",
          "client_request",
          "资源计划摘要无效。",
        ),
      );
    return this.#post(
      `/tasks/${pathId(id)}/authorize`,
      "TaskSnapshot",
      { planHash },
      etag,
      key,
    );
  }
  run(
    id: string,
    etag: string,
    authorizationVersion: number,
    key?: string,
  ): Promise<TaskSnapshot> {
    if (!validSchema("RunTask", { authorizationVersion }))
      return Promise.reject(
        new ApiError(0, "VALIDATION_ERROR", "client_request", "授权版本无效。"),
      );
    return this.#post(
      `/tasks/${pathId(id)}/runs`,
      "TaskSnapshot",
      { authorizationVersion },
      etag,
      key,
    );
  }
  cancel(id: string, etag: string, key?: string): Promise<TaskSnapshot> {
    return this.#post(
      `/tasks/${pathId(id)}/cancel`,
      "TaskSnapshot",
      {},
      etag,
      key,
    );
  }
  revoke(id: string, etag: string, key?: string): Promise<TaskSnapshot> {
    return this.#post(
      `/tasks/${pathId(id)}/revoke`,
      "TaskSnapshot",
      {},
      etag,
      key,
    );
  }
  budget(id: string): Promise<BudgetView> {
    return this.#get(`/tasks/${pathId(id)}/budget`, "BudgetView");
  }
  payments(id: string): Promise<PaymentList> {
    return this.#get(`/tasks/${pathId(id)}/payments`, "PaymentList");
  }
  payment(id: string, paymentId: string): Promise<PaymentView> {
    return this.#get(
      `/tasks/${pathId(id)}/payments/${pathId(paymentId)}`,
      "PaymentView",
    );
  }
  decision(id: string, paymentId: string): Promise<DecisionView> {
    return this.#get(
      `/tasks/${pathId(id)}/payments/${pathId(paymentId)}/decision`,
      "DecisionView",
    );
  }
  reviews(id: string): Promise<ReviewList> {
    return this.#get(`/tasks/${pathId(id)}/reviews`, "ReviewList");
  }
  lessons(id: string): Promise<LessonList> {
    return this.#get(`/tasks/${pathId(id)}/lessons`, "LessonList");
  }
  evidence(id: string, evidenceId: string): Promise<EvidenceSummary> {
    return this.#get(
      `/tasks/${pathId(id)}/evidence/${pathId(evidenceId)}`,
      "EvidenceSummary",
    );
  }
  resolveReview(
    taskId: string,
    review: ReviewView,
    choice: ResolveReview["choice"],
    key?: string,
  ): Promise<ResolveReviewResult> {
    if (
      review.taskId !== taskId ||
      !validSchema("ResolveReview", {
        choice,
        snapshotHash: review.snapshotHash,
      })
    ) {
      return Promise.reject(
        new ApiError(
          0,
          "VALIDATION_ERROR",
          "client_request",
          "审批快照与任务不匹配。",
        ),
      );
    }
    return this.#post(
      `/tasks/${pathId(taskId)}/reviews/${pathId(review.reviewId)}/resolve`,
      "ResolveReviewResult",
      { choice, snapshotHash: review.snapshotHash },
      review.etag,
      key,
    );
  }

  /** Used by the fetch-stream subscriber; bearer stays in headers, never in the URL. */
  async openEventStream(
    taskId: string,
    lastSeq: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (!Number.isSafeInteger(lastSeq) || lastSeq < 0)
      throw new ApiError(
        0,
        "INVALID_EVENT_CURSOR",
        "client_request",
        "事件游标无效。",
      );
    const headers = this.#headers("text/event-stream");
    headers.set("Last-Event-ID", `${pathId(taskId)}:${lastSeq}`);
    const response = await fetch(
      `${this.baseUrl}/api/v1/tasks/${pathId(taskId)}/events`,
      { headers, signal, cache: "no-store" },
    );
    let mode: ExecutionMode;
    try {
      mode = this.#responseMode(response);
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    if (!response.ok) await this.#json(response, "ApiError");
    if (
      response.headers
        .get("Content-Type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "text/event-stream" ||
      !response.body
    ) {
      throw invalidResponse(response.status, "事件连接未返回有效的 SSE 流。");
    }
    this.#confirmMode(mode, response.status);
    return response;
  }
}
