# Motion Guard API 契约与联调

契约版本：`0.2.0`。`openapi.json` 是前后端共同的公开接口来源，采用 OpenAPI 3.1 / JSON Schema 2020-12，共 19 个操作。此目录仅包含契约、示例、校验和本机模拟工具，没有真实付款实现。

**版本区分：** HTTP `X-Contract-Version` 和 OpenAPI 版本为 `0.2.0`；既有 TaskSnapshot、Catalog、PaymentView、ApiError、EventEnvelope 等对象的 `schemaVersion` 保持 `0.1.0`，表示对象格式沿用，避免迁移既有持久数据。新 TaskResult 的 `schemaVersion` 为 `0.2.0`。客户端不能拿 body.schemaVersion 代替请求版本 header；所有路径仍以 `/api/v1` 开头。

## 开发入口

```powershell
cd D:\Motion\contracts
npm ci
npm run validate
npm run mock
```

默认地址 `http://127.0.0.1:4010`。运行 `npm run check` 会验证契约并运行模拟服务的内置交互检查；`node mock-server.mjs --check` 不会留下后台服务。

模拟服务始终返回 `X-Execution-Mode: MOCK`、`X-Mock-Auth: NOT_VALIDATED`。它不验证真实身份，不调用模型、RPC、facilitator 或商家，不加载钱包，不生成真实签名，也没有真实链上结算。所有示例的 `transactionHash` 均为 null。不要将模拟结果计入真实支付、安全评测或资金账本。

可用场景为 `normal`、`blocked`、`review`、`unknown`、`lesson`。启动时使用 `node mock-server.mjs --scenario=review --port=4010`；也可仅在模拟服务创建任务时传 `X-Mock-Scenario: review`。该 header 是本地开发辅助，不属于产品 API；真实部署应拒绝或忽略它，不能由其选择安全结果。服务重启会清空模拟数据。

## 请求、认证和并发约定

每个请求携带 `X-Contract-Version: 0.2.0`。真实 operator API 使用不透明会话 bearer，浏览器仅存内存，不放 localStorage、URL、SSE query、日志或模型上下文。模拟服务可以不带 bearer 或使用明确的占位 token，它不代表真实认证通过。**任何 TESTNET 付款前都必须实现 operator-session 校验、用户/任务访问控制与可信用户入口；不能沿用模拟认证。**

所有 POST 必须有 `Idempotency-Key`，8–128 位，仅字母、数字、`.`、`_`、`:`、`-`。同一路径、同键、同请求体返回原响应并设置 `Idempotency-Replayed: true`；同键不同体为 409。真实实现还必须将幂等记录按已认证 operator/task 隔离；模拟服务只提供单个不具备真实身份的开发会话。

修改已有任务的 POST 还必须携带该任务最新的强 `If-Match`，例如 `"task_abc:v3"`。从 GET TaskSnapshot 的 `etag` 或响应 ETag 获取，不能使用 `*`。版本不符返回 412，缺失返回 428。review resolve 使用 **ReviewView.etag**，不是任务 ETag。幂等重放在版本检查之前返回原结果；不要因重放时版本已更新而生成第二个动作。

所有响应携带契约版本和执行模式；成功 JSON 资源响应还带 ETag。时间是 UTC ISO 8601，前端显示时本地化；金额均为原子单位整数字符串。固定 USDC 精度为 6，例如 `10000` 表示 0.01 USDC。授权判定不得依赖 JS 浮点。

## 最小用户流程

1. `GET /api/v1/catalog` 读取可信商家、工具、路由和资产；不允许客户端提交任意付款 URL。
2. `POST /api/v1/tasks` 提交原始用户目标、允许的 catalog vendor ID、预算、最大付费次数和有效期，得到 DRAFT TaskSnapshot。
3. `POST /api/v1/tasks/{taskId}/plan` 进入 PLANNING。此阶段只使用可信用户输入与 catalog，禁读网页、工具结果或其他不可信内容。异步完成后状态为 AWAITING_AUTHORIZATION。
4. `GET /api/v1/tasks/{taskId}/resource-plan` 展示用户待确认的计划。每项固定 resourceKind、tool/vendor/route、selectors、单价/次数/小计上限及依赖。
5. 用户 `POST .../authorize`，请求体只含准确 `planHash`，并带最新任务 If-Match。后端冻结原目标、plan、catalog、预算和授权版本，任务变为 READY。
6. `POST .../runs` 携带冻结的 `authorizationVersion` 启动。前端通过任务快照和 SSE 显示运行结果。
7. 任务运行结束后 `GET /api/v1/tasks/{taskId}/result` 读取完整纯文本报告、引用来源和模型诊断。尚未生成返回 409 `RESULT_NOT_READY`；任务不存在返回 404。结果是只读快照，响应自带强 ETag，不触发再次运行或付款。

M0 不提供 PATCH 授权、增加额度、增添商家或运行后修改 ResourcePlan 的接口。需要改变范围时重新创建任务，重新规划并由用户授权。业务 Agent、经验库和模型复核不能自行扩权。

各 GET 的结果都是独立、只读快照，前端不能修改收到的对象来冒充后端状态。mutation 返回新快照；遇到 412 先重新读取并向用户展示变化，不能自动替换 ETag 后重放涉及资金的操作。202 仅表示已受理，不表示任务完成或已经付款。`frontend` 与 `backend` 分别消费本契约，不能各维护一套不同状态或金额类型。

创建任务示例：

```http
POST /api/v1/tasks
Authorization: Bearer <仅内存的operator-session>
X-Contract-Version: 0.2.0
Idempotency-Key: create-demo-001
Content-Type: application/json

{"goal":"比较指定供应商的交付条件","allowedVendorIds":["vendor_alpha"],"budgetAtomic":"1000000","maxPaidCalls":3,"expiresAt":"2099-01-01T00:00:00.000Z"}
```

## 付款、判定、来源与资金状态

读取接口：

- `GET /tasks/{taskId}/payments` 与 `GET /tasks/{taskId}/payments/{paymentId}`。
- `GET /tasks/{taskId}/payments/{paymentId}/decision`。
- `GET /tasks/{taskId}/evidence/{evidenceId}`。
- `GET /tasks/{taskId}/budget`。

以上路径均以 `/api/v1` 开头。PaymentView 只有受控 catalog ID、HTTP method、精确金额/资产/payTo、不可逆操作状态和公开回执摘要，没有任意 URL 付款、通用签名或直接执行入口。DecisionView 的 `hardGate: BLOCK` 不能由模型一致同意或用户 review 覆盖。

`executionMode`、`authorizationStatus`、`receipt.status` 必须一起展示：

| 情况 | 表示 |
|---|---|
| MOCK + SIMULATED + SIMULATED | 仅模拟签名/结算，没有真实资金动作 |
| MOCK + SIMULATED + UNKNOWN | 模拟“已产生授权但结算未知”的恢复场景，仍不是真实签名 |
| TESTNET + SIGNED_TESTNET + PENDING/UNKNOWN | 已创建真实测试网授权，不能因缺少 HTTP 200 释放额度 |
| TESTNET + SIGNED_TESTNET + CONFIRMED | 独立链上核验后的结算；商家自报成功不足以得到此状态 |
| NOT_CREATED + NONE | 未产生付款授权，适用于阻断或待审 |

资金快照满足 `settledAtomic + reservedAtomic + outstandingAtomic + availableAtomic = limitAtomic`，各项互不重叠。SIGNED/UNKNOWN 的资金转入 outstanding。取消和撤销只能阻止后续新签名，已发 EIP-3009 仍可能兑付，不能显示成全部退回。

来源数据只来自宿主登记。模型输出自动继承实际消费的父来源闭包与最低信任级，不能挑选“干净的证据 ID”把污染摘要升级为授权。EvidenceSummary 返回脱敏纯文本和摘要，前端始终转义显示，不执行 HTML、命令或外链。

## 免费数据与完整报告

Catalog vendor 可带 `billing: {kind: "FREE_PUBLIC_DATA", amountAtomic: "0", requiresPayment: false}` 和 `source: {name, url, docsUrl}`。仅明确声明该免费计费方式时 `payTo` 才能为 null；普通付款商家的收款地址规则保持不变。source 是可信目录声明的公开来源，不是前端或模型提交任意 URL 的入口。

免费资源的计划单价/小计为字符串 `"0"`，读取次数仍受冻结计划限制。兼容旧格式的 item.maxPaidCalls 首版可为 1，免费项应在 UI 显示为“最多读取 1 次”；实际免费路径的 TaskResult.paidCalls 必须为 0，不生成 PaymentIntent、模拟收据或资金占额。付款预算不等于模型 API 费用授权，免费数据也不意味着模型调用没有费用。

`TaskResult` 顶层 closed，包含：

- `schemaVersion: "0.2.0"`、taskId、status（COMPLETED / BLOCKED / FAILED）、最长 12000 字符的纯文本 report。
- `sources[]`：evidenceId、公开 HTTPS url、name、observedAt（UTC）、contentHash。来源 ID 必须存在于本结果 evidenceIds 并归属当前任务；模型编造链接不能直接变成引用。URL 不含凭据，界面将报告和名称按纯文本转义，链接仅作为用户主动访问的来源。
- `model.mode`（LIVE_API / DETERMINISTIC_SANDBOX）和 diagnostics：callId、role、requestedModel、startedAt、latencyMs、status、maxOutputTokens、thinking；可选 phase（select / report）、actualModel、httpStatus、errorCategory、finishReason、usage。role 仍是 worker / threat / consistency / curator；报告阶段可使用 worker + phase=report，不新增角色。
- `dataMode`（LIVE_HTTP / SANDBOX）、`paymentMode: "MOCK"`、paidCalls 和 `learningMode`（SANDBOX_ORACLE / NO_ONLINE_LABELS）。LIVE_HTTP 必须使用 NO_ONLINE_LABELS，不把真实网页内容自动标成已确认攻击。

运行层标记独立展示：LIVE_API 表示真实模型适配器，诊断中的 SUCCEEDED 才表示该次调用成功；LIVE_HTTP 表示实际数据访问模式，不能据此推断实链付款。0.2 公共付款能力仍为 MOCK。免费公开数据通常是 LIVE_API + LIVE_HTTP + MOCK + paidCalls=0；MOCK 付款标记不能把真实模型和数据也统称为模拟。

diagnostics 只含安全元数据，不提供 endpoint、key、请求头、prompt、模型原始回复、隐藏推理或异常堆栈。usage 仅在提供方实际返回时存在，缺失不是 0。错误分类为 TIMEOUT、NETWORK、HTTP_AUTH、HTTP_BALANCE、HTTP_RATE_LIMIT、HTTP_REQUEST、HTTP_SERVER、HTTP_OTHER、INVALID_RESPONSE、INVALID_OUTPUT、OUTPUT_LIMIT、INPUT_INVALID；界面不解析任意远端错误正文。

TaskSnapshot.summary 仍只是最长 500 字符摘要，EvidenceSummary.excerpt 仍是最长 1200 字符证据片段，完整报告从 result getter 获取。原 SSE 的 schemaVersion 仍为 0.1.0；本版不增加新事件，客户端收到任务终态或 task.updated 后重新读取结果快照，断线后先恢复任务快照再查询结果。

`fixtures/task-result.json`、`task-result-failed.json` 和 `catalog-free.json` 仅为格式示例，没有执行对应模型或公开数据访问。mock 的 result 永远为 DETERMINISTIC_SANDBOX + SANDBOX + MOCK，并在 report 中写明未实际读取或付款；不能把 fixture 中的示例诊断当作实跑证据。

## REVIEW 交互

`GET /tasks/{taskId}/reviews` 返回 review 的精确快照、金额、完整收款地址、理由、expiry、snapshotHash 和每项 ETag。`PENDING` 才能 resolve。前端展示“批准这笔计划内付款”和“拒绝”，不提供“忽略硬策略继续”按钮。

```http
POST /api/v1/tasks/task_abc/reviews/review_xyz/resolve
X-Contract-Version: 0.2.0
Idempotency-Key: resolve-demo-001
If-Match: "review_xyz:v1"
Content-Type: application/json

{"choice":"APPROVE","snapshotHash":"sha256:<服务端快照的64位小写hex摘要>"}
```

批准仅对准确的 intent/request/offer/plan/授权版本有效，不能批准同一商家的另一笔请求。后端在批准后重新检查授权、报价、硬策略和预算，再 reserve/sign/send；若数据变化则 STALE，过期则 EXPIRED，返回 409，不自动批准替代报价。重复同幂等请求返回原结果；不能再次触发付款。REJECTED 不生成签名。

resolveReview 的 200 包装对象同时含 review 与 task，响应 ETag 必须等于嵌套 `review.etag`，包括幂等重放与重启后的重放；不能使用 task.etag 或包装对象的通用 hash 代替。前端按资源分别保存两个 ETag。

`POST /tasks/{taskId}/cancel` 取消任务；`POST /tasks/{taskId}/revoke` 撤销授权。两者请求体均为 `{}`，需要任务 If-Match 和幂等键。取消/撤销时仍显示剩余 outstanding，不将它们当退款接口。

## SSE：fetch 流与断线恢复

`GET /api/v1/tasks/{taskId}/events` 使用 `text/event-stream`。原生 EventSource 不能添加 bearer 和版本 header，因此使用 fetch streaming，而不是把 token 放进 URL。客户端先 GET TaskSnapshot，再用其 `taskId:lastEventSeq` 作为 Last-Event-ID。示例只表示连接方式，实际 UI 需处理完整 SSE 分帧、重连和 AbortSignal：

```javascript
const response = await fetch(`${base}/api/v1/tasks/${taskId}/events`, {
  headers: {
    Authorization: `Bearer ${sessionToken}`,
    'X-Contract-Version': '0.2.0',
    'Last-Event-ID': `${taskId}:${lastSeq}`,
  },
  signal,
});
if (response.status === 410) {
  // 重新GET任务快照，读取lastEventSeq，再连接；保留新的ETag。
}
// 成功后按SSE规则逐帧解析response.body；不要把一个网络chunk当一个完整event。
```

事件格式为 `id: taskId:seq`、`event: <type>`、`data: <EventEnvelope JSON>`。`seq` 在单任务中单调递增，至少一次交付，客户端去重；心跳注释不推进业务 seq。无 Last-Event-ID 只订阅未来事件；`:0` 请求从最早保留事件重放。游标早于保留窗口返回 410 `EVENT_CURSOR_EXPIRED` JSON，带 `minEventSeq` 与 `snapshotPath`，不能悄悄丢事件并声称已同步。

SSE只传权威状态摘要和资源引用，不传模型 token 流、隐藏推理或原始签名。断线不取消任务；真正取消要调用 cancel。快照是状态恢复依据，事件不是浏览器本地修改授权的依据。

## 经验和错误

`GET /tasks/{taskId}/lessons` 返回只读 lesson 摘要、memoryVersion 和晋升检查结果。ACTIVE 要求可信来源、原事件、至少两个变体、至少两个良性反例、完整开发回归以及权限不变；前端没有直接改 ACTIVE、放松策略或增加额度的接口。示例来自 `fixtures/active-lesson.json`，仅用于界面联调，不代表真实学习实验已完成。

统一错误为 `ApiError`：`schemaVersion` 和 `error { code, message, requestId, details? }`。界面按稳定 code 显示，不解析 message 来决定是否付款。

| HTTP | 主要含义 |
|---|---|
| 400 | 缺少契约/幂等 header、无效 JSON、非法游标 |
| 401 / 403 | 真实会话缺失或无权访问；MOCK不验证真实身份 |
| 409 | INVALID_TASK_STATE、IDEMPOTENCY_CONFLICT、STALE_REVIEW、REVIEW_EXPIRED |
| 410 | EVENT_CURSOR_EXPIRED，重新获取任务快照 |
| 412 | PRECONDITION_FAILED，目标资源 ETag 已改变 |
| 422 | VALIDATION_ERROR、PLAN_MISMATCH、HARD_POLICY_BLOCK；不能用review越过 |
| 428 | PRECONDITION_REQUIRED，缺少 If-Match |

## 版本维护与前后端提交

版本 header、OpenAPI info.version、x-contract-version 和 fixtures manifest 同步为 `0.2.0`；既有对象格式固定为 `schemaVersion: "0.1.0"`，新增 TaskResult 使用 `"0.2.0"`。不兼容字段、枚举或状态语义变化必须先更新契约版本和 API_GUIDE，再分别提交前后端适配；新增字段也需更新 schema、fixtures 和联调。M0不依赖“客户端忽略未知字段”来绕过版本差异。

前端使用只读 OpenAPI/client/types 和 fixtures；后端实现相同公开 view，不直接泄露内部数据库行。开发者先 `npm run validate`，再 `npm run check`，最后用真实后端覆盖一次完整用户流程。各自提交可以独立进行，合并前需要检查同一契约快照；模拟测试通过不能替代真实 backend 集成或测试网验证。

禁止通过公共API、SSE、fixtures、日志或前端持久存储输出：付款私钥、模型/API key、operator bearer、IPC凭据、原始可兑付签名、execution grant、隐藏推理或未脱敏证据。前端不能直连 signer，也不能用任意 URL 或付款参数绕过已冻结 ResourcePlan。
