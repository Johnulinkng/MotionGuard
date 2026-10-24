# 真实模式最终独立复核

复核时间：2026-10-24 16:25 Asia/Shanghai。对象为当前 0.2.0 工作树的 live workflow、B 结果发布边界、runtime 与公开资源读取路径。本轮仅审源码和运行离线负例，没有读取 `.env`、真实密钥或真实任务数据库，也没有调用付费模型或实时外部数据。

## 结论

当前实现已具有独立的真实运行路径：严格要求模型配置，读取固定可信目录中的公开 HTTP/RPC 数据，生成带来源的纯文本报告，通过 0.2.0 只读 result API 返回。公开免费数据不创建支付意图；付款模式仍为 MOCK，不能称为真实 x402 商家付款或链上结算。本复核未发现尚待修复的明确资金旁路；实际模型与公开数据端到端结果由协调者和前端在部署后另外验收。

本轮发现的密钥回显、取消后晚到状态、声明引用集合不一致及 B 端来源次序绑定问题，已由实现负责人修复，独立专项回归 **6/6 通过**，严格 TypeScript 检查通过。该结果只证明以下离线安全与一致性边界，不证明模型事实准确率或正式学习增益。

## 已核验的边界

| 检查 | 当前证据与结论 |
| --- | --- |
| 引用 `[n]` 顺序 | `agents/live-workflow.ts` 先按提供给报告模型的 selected 来源顺序排列公开 sources，再追加其他来源；逆序完成的读取不会改变编号。报告中的编号必须有效，映射后的来源 ID 集合必须与 sourceEvidenceIds 的唯一集合一致。独立测试覆盖逆序读取、selected 子集及不一致声明。 |
| B 证据绑定 | `service.ts` 的 saveResult 检查 task、mode、状态、证据全集、来源 URL/name、所属任务和已登记 TOOL_RESPONSE 的 contentHash。COMPLETED 还须有成功的 report 阶段诊断，以及与完整 report 的 digest/脱敏片段匹配的 MODEL_OUTPUT；报告直接父来源次序必须等于公开 sources 的前 N 项，引用来源须在父闭包内。独立测试验证正常结果可存，替换正文或交换合法来源顺序均被拒绝。 |
| 模型/来源失败 | live workflow 不走 buildSandboxResources；必需调用、格式或来源失败产生 FAILED，没有固定采购文本替代。B 对 live COMPLETED 要求 LIVE_API、成功报告调用、来源及绑定报告证据；实际 source 或 model 失败不能借用户付款审批变成研究成功。离线失败负例通过。 |
| 免费不可造费 | 资源目录为显式 FREE_PUBLIC_DATA、0 金额、null payTo，固定路由与受限 selector。读取器遇到 HTTP 402 直接拒绝，没有付款回退。live workflow 不构造 offer/PaymentIntent，service.onIntent 在 live 模式拒绝付款，policy.preparePayment 再拒 FREE 资源。专项运行付费 callback 次数为 0，paidCalls 为 0。 |
| 输出与密钥 | provider 不保留/公开远端错误正文；诊断仅含闭合的安全元数据。成功文本及 JSON 解码后的所有键/值均检查是否含精确配置密钥，避免转义回显通过；离线伪密钥回显被拒绝，错误和诊断不含该值。API/SSE 不返回原始 messages、请求头或隐藏推理。未读取真实 key，因此不把该测试称为真实密钥扫描。 |
| 取消与晚到发布 | service 的活动运行判定绑定任务状态、授权版本、planHash 和目录；取消/撤销后，晚到 evidence 被拒，telemetry 不改变任务摘要或事件 seq，最终结果不再发布。runtime.cancelTask 清除待处理请求并通知 A。专项验证取消后证据数、摘要与事件序号均保持。 |
| 并发诊断 | `runtime/worker.ts` 为每个 live run 创建独立 provider/诊断缓存；workflow 在 finally 取消监听，并等待并行读取/检查全部 settle 后收尾。源码未见跨任务共享诊断缓冲。这里是静态复核；本专项没有发起真实并发模型请求。 |
| 在线经验标签 | live 结果固定 NO_ONLINE_LABELS，oracle 为 UNCONFIRMED，不运行 sandbox oracle 晋升。专项确认无 lesson 被创建；不能宣称真实网页攻击已经独立确证或正式学习效果已完成。 |

## 独立执行记录

在 backend 中运行：

```powershell
node --import tsx --test test/security-real-final.test.ts
npx tsc --noEmit
```

专项 6/6 通过，包含：逆序读取与引用映射、引用集合不一致、模型/来源失败、配置密钥回显、B 报告正文和来源顺序绑定、取消后晚到回调。测试模型和读取器均为进程内 doubles，没有真实模型或网络费用；取消测试直接调用 B 服务逻辑并用临时内存 SQLite，不连接实际 4011 数据。无产品源码由此审计者修改。

此前契约独立验收为 19 个操作、30 个 schema、12 个 fixtures、12/12 契约测试及 mock 195 项检查。契约/mock 通过与真实后端、模型、数据、链上验收是不同层。既有对象 schemaVersion 保持 0.1.0，新 TaskResult 为 0.2.0，请求 header 为 0.2.0。

## 保留的实际限制

- 来源 hash、读取时间和闭合引用能核对数据链路，不能证明外部数据本身真实、模型结论充分或报告每个事实均有依据。当前数据是时点报价、TVL 或测试网链状态，不能自动推断长期趋势或主网交易活动。
- 取消阻止后续发布和付款，不保证撤回提供方已经接受的模型请求；正在进行的调用可能到超时或完成后才终止，已有模型 API 费用不会因此自动退款。
- A/B/C 仍是同一 OS 用户下的三个进程；本次边界没有声称能抵御原生进程入侵、文件系统越权或被攻陷的模型提供方。诊断是受控适配器记录，不是第三方密码学调用证明。
- HTTP TESTNET 仍拒绝启用。真实付费 x402 需要已验证商家、明确钱包/资产授权、精确报价、durable 签名/发送与链回执验证，当前免费数据路径没有这些资金动作。用户提供模型 key 不等于授权钱包支付。
- 真实模型和公开数据的唯一任务 Chrome 验收、部署后结果核对、正式攻击矩阵与 heldout 学习评测，均未由本轮离线审计执行。后续报告应引用各自实际运行证据，不能复用这些离线分数充当实跑证明。
