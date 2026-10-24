// Generated from fixed OpenAPI snapshot. Run npm run generate; do not edit.
export type ApiError = {
  "schemaVersion": "0.1.0";
  "error": {
  "code": string;
  "message": string;
  "requestId": string;
  "details"?: {
  "field"?: string;
  "currentEtag"?: string;
  "minEventSeq"?: number;
  "snapshotPath"?: string;
};
};
};

export type Asset = {
  "network": "eip155:84532";
  "tokenAddress": string;
  "symbol": "USDC";
  "decimals": 6;
};

export type Catalog = {
  "schemaVersion": "0.1.0";
  "catalogVersion": string;
  "asset": Asset;
  "vendors": Array<{
  "vendorId": string;
  "name": string;
  "payTo": string | null;
  "toolId": string;
  "routeId": string;
  "resourceKind": "DOCUMENT" | "MARKET_DATA" | "ANALYSIS";
  "description": string;
  "toolDescriptorHash": string;
  "billing"?: PublicDataBilling;
  "source"?: CatalogSource;
}>;
};

export type CreateTask = {
  "goal": string;
  "allowedVendorIds": Array<string>;
  "budgetAtomic": string;
  "maxPaidCalls": number;
  "expiresAt": string;
};

export type BudgetView = {
  "schemaVersion": "0.1.0";
  "taskId": string;
  "asset": Asset;
  "limitAtomic": string;
  "settledAtomic": string;
  "reservedAtomic": string;
  "outstandingAtomic": string;
  "availableAtomic": string;
  "version": number;
};

export type ResourcePlanItem = {
  "itemId": string;
  "goalStepId": string;
  "resourceKind": "DOCUMENT" | "MARKET_DATA" | "ANALYSIS";
  "toolId": string;
  "vendorId": string;
  "routeId": string;
  "selectors": {
  "entityIds"?: Array<string>;
};
  "unitPriceCapAtomic": string;
  "maxPaidCalls": number;
  "subtotalCapAtomic": string;
  "dependsOn": Array<string>;
  "purpose": string;
};

export type ResourcePlan = {
  "schemaVersion": "0.1.0";
  "planId": string;
  "taskId": string;
  "version": number;
  "status": "DRAFT" | "FROZEN";
  "goalHash": string;
  "catalogVersion": string;
  "planHash": string;
  "items": Array<ResourcePlanItem>;
  "totalCapAtomic": string;
  "expiresAt": string;
  "createdAt": string;
};

export type AuthorizationView = {
  "authorizationId": string;
  "version": number;
  "status": "ACTIVE" | "REVOKED";
  "planHash": string;
  "goalHash": string;
  "catalogVersion": string;
  "budgetAtomic": string;
  "maxPaidCalls": number;
  "expiresAt": string;
  "authorizedAt": string;
  "revokedAt": string | null;
};

export type TaskSnapshot = {
  "schemaVersion": "0.1.0";
  "taskId": string;
  "version": number;
  "etag": string;
  "status": "DRAFT" | "PLANNING" | "AWAITING_AUTHORIZATION" | "READY" | "RUNNING" | "PAUSED_REVIEW" | "AWAITING_SETTLEMENT" | "COMPLETED" | "CANCELLED" | "FAILED";
  "goal": string;
  "allowedVendorIds": Array<string>;
  "executionMode": "MOCK" | "TESTNET";
  "authMode": "MOCK_UNAUTHENTICATED" | "OPERATOR_SESSION";
  "planId": string | null;
  "planHash": string | null;
  "authorization": AuthorizationView | null;
  "activeMemoryVersion": string;
  "budget": BudgetView;
  "pendingReviewCount": number;
  "lastEventSeq": number;
  "createdAt": string;
  "updatedAt": string;
  "summary": string | null;
};

export type AuthorizeTask = {
  "planHash": string;
};

export type RunTask = {
  "authorizationVersion": number;
};

export type EmptyMutation = {

};

export type EvidenceSummary = {
  "schemaVersion": "0.1.0";
  "evidenceId": string;
  "taskId": string;
  "sourceKind": "USER_INPUT" | "TRUSTED_CATALOG" | "TOOL_RESPONSE" | "MODEL_OUTPUT" | "HOST_CHECK";
  "trust": "USER_TRUSTED" | "HOST_OBSERVED" | "EXTERNAL_UNTRUSTED" | "MODEL_DERIVED";
  "parentIds": Array<string>;
  "parentClosureHash": string;
  "contentHash": string;
  "excerpt": string;
  "recordedAt": string;
};

export type DecisionView = {
  "schemaVersion": "0.1.0";
  "decisionId": string;
  "taskId": string;
  "paymentId": string;
  "type": "ALLOW" | "REVIEW" | "BLOCK";
  "hardGate": "PASS" | "BLOCK";
  "reasonCodes": Array<string>;
  "summary": string;
  "requestHash": string;
  "offerHash": string;
  "evidenceIds": Array<string>;
  "planHash": string;
  "authorizationVersion": number;
  "policyVersion": string;
  "memoryVersion": string;
  "reviewers": Array<{
  "role": "THREAT" | "CONSISTENCY";
  "verdict": "ALLOW" | "REVIEW" | "BLOCK" | "ERROR";
  "reasonCode": string;
  "evidenceIds": Array<string>;
}>;
  "expiresAt": string;
};

export type ReceiptView = {
  "status": "NONE" | "SIMULATED" | "PENDING" | "CONFIRMED" | "UNKNOWN";
  "transactionHash": string | null;
  "mockReceiptId": string | null;
  "checkedAt": string | null;
};

export type PaymentView = {
  "schemaVersion": "0.1.0";
  "paymentId": string;
  "taskId": string;
  "version": number;
  "planItemId": string;
  "logicalPurchaseId": string;
  "state": "CREATED" | "RESERVED" | "SIGNED" | "DISPATCHED" | "SETTLED" | "REJECTED" | "EXPIRED" | "UNKNOWN";
  "executionMode": "MOCK" | "TESTNET";
  "authorizationStatus": "NOT_CREATED" | "SIMULATED" | "SIGNED_TESTNET";
  "vendorId": string;
  "toolId": string;
  "routeId": string;
  "resourceKind": "DOCUMENT" | "MARKET_DATA" | "ANALYSIS";
  "method": "GET" | "POST";
  "asset": Asset;
  "payTo": string;
  "amountAtomic": string;
  "requestHash": string;
  "offerHash": string;
  "decision": DecisionView;
  "receipt": ReceiptView;
  "createdAt": string;
  "updatedAt": string;
};

export type PaymentList = {
  "schemaVersion": "0.1.0";
  "items": Array<PaymentView>;
  "nextCursor": string | null;
};

export type ReviewView = {
  "schemaVersion": "0.1.0";
  "reviewId": string;
  "taskId": string;
  "paymentId": string;
  "version": number;
  "etag": string;
  "status": "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "STALE" | "CANCELLED";
  "snapshotHash": string;
  "requestHash": string;
  "offerHash": string;
  "planHash": string;
  "authorizationVersion": number;
  "reasonCode": string;
  "summary": string;
  "amountAtomic": string;
  "payTo": string;
  "vendorId": string;
  "expiresAt": string;
  "createdAt": string;
  "resolvedAt": string | null;
};

export type ReviewList = {
  "schemaVersion": "0.1.0";
  "items": Array<ReviewView>;
};

export type ResolveReview = {
  "choice": "APPROVE" | "REJECT";
  "snapshotHash": string;
};

export type ResolveReviewResult = {
  "schemaVersion": "0.1.0";
  "review": ReviewView;
  "task": TaskSnapshot;
};

export type LessonView = {
  "schemaVersion": "0.1.0";
  "lessonId": string;
  "version": number;
  "status": "QUARANTINED" | "ACTIVE" | "REVOKED";
  "mechanism": string;
  "summary": string;
  "applicability": string;
  "sourceEvidenceIds": Array<string>;
  "memoryVersion": string;
  "promotion": {
  "promotionId": string;
  "originReplayPassed": boolean;
  "variantPassed": number;
  "benignPassed": number;
  "regressionPassed": boolean;
  "permissionsUnchanged": boolean;
  "publishedAt": string | null;
};
};

export type LessonList = {
  "schemaVersion": "0.1.0";
  "items": Array<LessonView>;
  "memoryVersion": string;
};

export type EventEnvelope = {
  "schemaVersion": "0.1.0";
  "eventId": string;
  "taskId": string;
  "seq": number;
  "type": "task.created" | "task.updated" | "plan.planning" | "plan.ready" | "authorization.frozen" | "run.started" | "review.required" | "review.resolved" | "review.expired" | "payment.updated" | "budget.updated" | "lesson.promoted" | "task.completed" | "task.cancelled" | "authorization.revoked";
  "occurredAt": string;
  "aggregateVersion": number;
  "executionMode": "MOCK" | "TESTNET";
  "summary": string;
  "resourceId": string | null;
  "resourceType": "TASK" | "PLAN" | "AUTHORIZATION" | "PAYMENT" | "REVIEW" | "BUDGET" | "LESSON";
};

export type PublicDataBilling = {
  "kind": "FREE_PUBLIC_DATA";
  "amountAtomic": "0";
  "requiresPayment": false;
};

export type CatalogSource = {
  "name": string;
  "url": string;
  "docsUrl": string;
};

export type ProviderTokenUsage = {
  "promptTokens"?: number;
  "completionTokens"?: number;
  "totalTokens"?: number;
  "promptCacheHitTokens"?: number;
  "promptCacheMissTokens"?: number;
  "reasoningTokens"?: number;
};

export type ProviderCallDiagnostic = {
  "callId": string;
  "role": "worker" | "threat" | "consistency" | "curator";
  "requestedModel": string;
  "actualModel"?: string;
  "startedAt": string;
  "latencyMs": number;
  "status": "SUCCEEDED" | "FAILED";
  "httpStatus"?: number;
  "errorCategory"?: "TIMEOUT" | "NETWORK" | "HTTP_AUTH" | "HTTP_BALANCE" | "HTTP_RATE_LIMIT" | "HTTP_REQUEST" | "HTTP_SERVER" | "HTTP_OTHER" | "INVALID_RESPONSE" | "INVALID_OUTPUT" | "OUTPUT_LIMIT" | "INPUT_INVALID";
  "finishReason"?: "stop" | "length" | "content_filter" | "tool_calls" | "insufficient_system_resource" | "aborted" | "other";
  "usage"?: ProviderTokenUsage;
  "maxOutputTokens": number;
  "thinking": "disabled" | "not_requested";
  "phase"?: "select" | "report";
};

export type TaskResultSource = {
  "evidenceId": string;
  "url": string;
  "name": string;
  "observedAt": string;
  "contentHash": string;
};

export type TaskResult = {
  "schemaVersion": "0.2.0";
  "taskId": string;
  "status": "COMPLETED" | "BLOCKED" | "FAILED";
  "report": string;
  "sources": Array<TaskResultSource>;
  "evidenceIds": Array<string>;
  "model": {
  "mode": "LIVE_API" | "DETERMINISTIC_SANDBOX";
  "diagnostics": Array<ProviderCallDiagnostic>;
};
  "dataMode": "LIVE_HTTP" | "SANDBOX";
  "paymentMode": "MOCK";
  "paidCalls": number;
  "learningMode": "SANDBOX_ORACLE" | "NO_ONLINE_LABELS";
};
