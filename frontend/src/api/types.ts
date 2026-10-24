/** Public views from the owner-published, SHA-256-locked 0.2.0 snapshot. */
export const CONTRACT_VERSION = "0.2.0" as const;
/** Existing persisted views retain their 0.1 object format. */
export type SchemaVersion = "0.1.0";
export type ExecutionMode = "MOCK" | "TESTNET";
export type ResourceKind = "DOCUMENT" | "MARKET_DATA" | "ANALYSIS";
export type TaskStatus =
  | "DRAFT"
  | "PLANNING"
  | "AWAITING_AUTHORIZATION"
  | "READY"
  | "RUNNING"
  | "PAUSED_REVIEW"
  | "AWAITING_SETTLEMENT"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";
/** Atomic USDC amounts remain decimal integer strings throughout the client. */
export type AtomicAmount = string;

export interface ApiErrorPayload {
  schemaVersion: SchemaVersion;
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: {
      field?: string;
      currentEtag?: string;
      minEventSeq?: number;
      snapshotPath?: string;
    };
  };
}

export interface Asset {
  network: "eip155:84532";
  tokenAddress: string;
  symbol: "USDC";
  decimals: 6;
}

export interface CatalogVendor {
  vendorId: string;
  name: string;
  payTo: string | null;
  toolId: string;
  routeId: string;
  resourceKind: ResourceKind;
  description: string;
  toolDescriptorHash: string;
  billing?: { kind: "FREE_PUBLIC_DATA"; amountAtomic: "0"; requiresPayment: false };
  source?: { name: string; url: string; docsUrl: string };
}

export interface ProviderCallDiagnostic {
  callId: string;
  role: "worker" | "threat" | "consistency" | "curator";
  requestedModel: string;
  actualModel?: string;
  startedAt: string;
  latencyMs: number;
  status: "SUCCEEDED" | "FAILED";
  httpStatus?: number;
  errorCategory?: "TIMEOUT" | "NETWORK" | "HTTP_AUTH" | "HTTP_BALANCE" | "HTTP_RATE_LIMIT" | "HTTP_REQUEST" | "HTTP_SERVER" | "HTTP_OTHER" | "INVALID_RESPONSE" | "INVALID_OUTPUT" | "OUTPUT_LIMIT" | "INPUT_INVALID";
  finishReason?: "stop" | "length" | "content_filter" | "tool_calls" | "insufficient_system_resource" | "aborted" | "other";
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; promptCacheHitTokens?: number; promptCacheMissTokens?: number; reasoningTokens?: number };
  maxOutputTokens: number;
  thinking: "disabled" | "not_requested";
  phase?: "select" | "report";
}

export interface TaskResultSource {
  evidenceId: string;
  url: string;
  name: string;
  observedAt: string;
  contentHash: string;
}

export interface TaskResult {
  schemaVersion: "0.2.0";
  taskId: string;
  status: "COMPLETED" | "BLOCKED" | "FAILED";
  report: string;
  sources: TaskResultSource[];
  evidenceIds: string[];
  model: { mode: "LIVE_API" | "DETERMINISTIC_SANDBOX"; diagnostics: ProviderCallDiagnostic[] };
  dataMode: "LIVE_HTTP" | "SANDBOX";
  paymentMode: "MOCK";
  paidCalls: number;
  learningMode: "SANDBOX_ORACLE" | "NO_ONLINE_LABELS";
}

export interface Catalog {
  schemaVersion: SchemaVersion;
  catalogVersion: string;
  asset: Asset;
  vendors: CatalogVendor[];
}

export interface CreateTask {
  goal: string;
  allowedVendorIds: string[];
  budgetAtomic: AtomicAmount;
  maxPaidCalls: number;
  expiresAt: string;
}

export interface BudgetView {
  schemaVersion: SchemaVersion;
  taskId: string;
  asset: Asset;
  limitAtomic: AtomicAmount;
  settledAtomic: AtomicAmount;
  reservedAtomic: AtomicAmount;
  outstandingAtomic: AtomicAmount;
  availableAtomic: AtomicAmount;
  version: number;
}

export interface ResourcePlanItem {
  itemId: string;
  goalStepId: string;
  resourceKind: ResourceKind;
  toolId: string;
  vendorId: string;
  routeId: string;
  selectors: { entityIds?: string[] };
  unitPriceCapAtomic: AtomicAmount;
  maxPaidCalls: number;
  subtotalCapAtomic: AtomicAmount;
  dependsOn: string[];
  purpose: string;
}

export interface ResourcePlan {
  schemaVersion: SchemaVersion;
  planId: string;
  taskId: string;
  version: number;
  status: "DRAFT" | "FROZEN";
  goalHash: string;
  catalogVersion: string;
  planHash: string;
  items: ResourcePlanItem[];
  totalCapAtomic: AtomicAmount;
  expiresAt: string;
  createdAt: string;
}

export interface AuthorizationView {
  authorizationId: string;
  version: number;
  status: "ACTIVE" | "REVOKED";
  planHash: string;
  goalHash: string;
  catalogVersion: string;
  budgetAtomic: AtomicAmount;
  maxPaidCalls: number;
  expiresAt: string;
  authorizedAt: string;
  revokedAt: string | null;
}

export interface TaskSnapshot {
  schemaVersion: SchemaVersion;
  taskId: string;
  version: number;
  etag: string;
  status: TaskStatus;
  goal: string;
  allowedVendorIds: string[];
  executionMode: ExecutionMode;
  authMode: "MOCK_UNAUTHENTICATED" | "OPERATOR_SESSION";
  planId: string | null;
  planHash: string | null;
  authorization: AuthorizationView | null;
  activeMemoryVersion: string;
  budget: BudgetView;
  pendingReviewCount: number;
  lastEventSeq: number;
  createdAt: string;
  updatedAt: string;
  summary: string | null;
}

export interface AuthorizeTask {
  planHash: string;
}
export interface RunTask {
  authorizationVersion: number;
}
export type EmptyMutation = Record<string, never>;

export interface EvidenceSummary {
  schemaVersion: SchemaVersion;
  evidenceId: string;
  taskId: string;
  sourceKind:
    | "USER_INPUT"
    | "TRUSTED_CATALOG"
    | "TOOL_RESPONSE"
    | "MODEL_OUTPUT"
    | "HOST_CHECK";
  trust:
    | "USER_TRUSTED"
    | "HOST_OBSERVED"
    | "EXTERNAL_UNTRUSTED"
    | "MODEL_DERIVED";
  parentIds: string[];
  parentClosureHash: string;
  contentHash: string;
  excerpt: string;
  recordedAt: string;
}

export interface DecisionReviewer {
  role: "THREAT" | "CONSISTENCY";
  verdict: "ALLOW" | "REVIEW" | "BLOCK" | "ERROR";
  reasonCode: string;
  evidenceIds: string[];
}

export interface DecisionView {
  schemaVersion: SchemaVersion;
  decisionId: string;
  taskId: string;
  paymentId: string;
  type: "ALLOW" | "REVIEW" | "BLOCK";
  hardGate: "PASS" | "BLOCK";
  reasonCodes: string[];
  summary: string;
  requestHash: string;
  offerHash: string;
  evidenceIds: string[];
  planHash: string;
  authorizationVersion: number;
  policyVersion: string;
  memoryVersion: string;
  reviewers: DecisionReviewer[];
  expiresAt: string;
}

export interface ReceiptView {
  status: "NONE" | "SIMULATED" | "PENDING" | "CONFIRMED" | "UNKNOWN";
  transactionHash: string | null;
  mockReceiptId: string | null;
  checkedAt: string | null;
}

export interface PaymentView {
  schemaVersion: SchemaVersion;
  paymentId: string;
  taskId: string;
  version: number;
  planItemId: string;
  logicalPurchaseId: string;
  state:
    | "CREATED"
    | "RESERVED"
    | "SIGNED"
    | "DISPATCHED"
    | "SETTLED"
    | "REJECTED"
    | "EXPIRED"
    | "UNKNOWN";
  executionMode: ExecutionMode;
  authorizationStatus: "NOT_CREATED" | "SIMULATED" | "SIGNED_TESTNET";
  vendorId: string;
  toolId: string;
  routeId: string;
  resourceKind: ResourceKind;
  method: "GET" | "POST";
  asset: Asset;
  payTo: string;
  amountAtomic: AtomicAmount;
  requestHash: string;
  offerHash: string;
  decision: DecisionView;
  receipt: ReceiptView;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentList {
  schemaVersion: SchemaVersion;
  items: PaymentView[];
  nextCursor: string | null;
}

export interface ReviewView {
  schemaVersion: SchemaVersion;
  reviewId: string;
  taskId: string;
  paymentId: string;
  version: number;
  etag: string;
  status:
    | "PENDING"
    | "APPROVED"
    | "REJECTED"
    | "EXPIRED"
    | "STALE"
    | "CANCELLED";
  snapshotHash: string;
  requestHash: string;
  offerHash: string;
  planHash: string;
  authorizationVersion: number;
  reasonCode: string;
  summary: string;
  amountAtomic: AtomicAmount;
  payTo: string;
  vendorId: string;
  expiresAt: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ReviewList {
  schemaVersion: SchemaVersion;
  items: ReviewView[];
}
export interface ResolveReview {
  choice: "APPROVE" | "REJECT";
  snapshotHash: string;
}
export interface ResolveReviewResult {
  schemaVersion: SchemaVersion;
  review: ReviewView;
  task: TaskSnapshot;
}

export interface LessonView {
  schemaVersion: SchemaVersion;
  lessonId: string;
  version: number;
  status: "QUARANTINED" | "ACTIVE" | "REVOKED";
  mechanism: string;
  summary: string;
  applicability: string;
  sourceEvidenceIds: string[];
  memoryVersion: string;
  promotion: {
    promotionId: string;
    originReplayPassed: boolean;
    variantPassed: number;
    benignPassed: number;
    regressionPassed: boolean;
    permissionsUnchanged: boolean;
    publishedAt: string | null;
  };
}

export interface LessonList {
  schemaVersion: SchemaVersion;
  items: LessonView[];
  memoryVersion: string;
}

export type EventType =
  | "task.created"
  | "task.updated"
  | "plan.planning"
  | "plan.ready"
  | "authorization.frozen"
  | "run.started"
  | "review.required"
  | "review.resolved"
  | "review.expired"
  | "payment.updated"
  | "budget.updated"
  | "lesson.promoted"
  | "task.completed"
  | "task.cancelled"
  | "authorization.revoked";
export interface EventEnvelope {
  schemaVersion: SchemaVersion;
  eventId: string;
  taskId: string;
  seq: number;
  type: EventType;
  occurredAt: string;
  aggregateVersion: number;
  executionMode: ExecutionMode;
  summary: string;
  resourceId: string | null;
  resourceType:
    | "TASK"
    | "PLAN"
    | "AUTHORIZATION"
    | "PAYMENT"
    | "REVIEW"
    | "BUDGET"
    | "LESSON";
}
