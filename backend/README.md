# Motion Guard 后端

可运行的本地支付防火墙。公共 API 为 0.2.0。正常启动使用真实模型和真实公开资料，缺配置或调用失败时直接失败。模型、资料、付款和经验标签分别标记；当前 HTTP 付款模式仍为 MOCK。

需要 Node.js 24 或更高版本、npm。首次运行：

```powershell
Set-Location backend
npm ci
Copy-Item .env.example .env
npm start
```

已有 .env 时保留原文件，在 MOTION_LLM_API_KEY 填入后端模型密钥。默认地址 http://127.0.0.1:4011，API 前缀 /api/v1；请求必须带 X-Contract-Version: 0.2.0。开发前端通过 5173 的代理连接 4011。本机未设 operator token 时返回 MOCK_UNAUTHENTICATED；设置 MOTION_OPERATOR_TOKEN 后全部业务 API 需要对应 Bearer 会话。

.env.example 只含空密钥和公开配置。正常模式 MOTION_RESOURCE_MODE=live、MOTION_LLM_MODE=real、MOTION_ENABLE_DEMO_SCENARIOS=0。DeepSeek 使用 JSON 输出并关闭 thinking；报告阶段单次上限 1536 tokens，其余角色上限 384 tokens，不自动重试。真实模型费用由提供方账户承担，不能因资料免费而声称模型免费。

固定只读来源为 Base Sepolia 官方 RPC、DefiLlama ETH/USD 和 Ethereum/Base TVL，无需钱包或数据 API key。资源计划在读取前冻结，免费项收款人为 null、单价/小计为 0；不创建付款意图或模拟收据。报告来自实际模型输出，GET /tasks/{taskId}/result 提供完整报告、来源、证据 ID 和实际模型/usage/延迟。TaskSnapshot.summary 仅为 500 字符预览。资料或模型失败时保存失败结果，不以沙箱替代。

只需离线演示时，显式设置 MOTION_RESOURCE_MODE=sandbox、MOTION_LLM_MODE=sandbox，清空三项模型连接配置，再设 MOTION_ENABLE_DEMO_SCENARIOS=1。该选项仅允许回环地址与 MOCK。五场景执行图、策略和账本，结果明确为 SANDBOX；合约 mock 4010 独立于真实后端。

验证命令：

```powershell
npm run check
npm run contract:check
npm run preflight -- --check-rpc
npm run preflight -- --check-model
npm run verify:real -- task_实际任务ID
```

check 生成固定契约的 TS 类型、运行严格类型检查和全部单元、HTTP、恢复测试，默认不调用外网。contract:check 仅校验规范和快照；不能替代 provider 测试。preflight 默认检查配置存在性与快照 hash，显式参数分别发一次只读 RPC 或模型配置探针，输出不含密钥。verify:real 只读取已有任务与其证据，验证真实报告、模型成功诊断、资料来源和零收费，不发新模型请求。smoke:local 仅适用于显式启动的旧沙箱五场景服务，会拒绝正常真实来源目录。

## 运行与安全边界

A：src/runtime/worker.ts 执行业务图，环境仅继承模型配置和必要 OS 字段。正常真实资料路径运行 Worker 选择与报告、Threat、Consistency；Curator 在有沙箱 oracle 的演示路径运行。真实资料无确认攻击标签时不触发经验晋升。Agent 使用独立经验库，不能通过 IPC 调用任意 signer 或写资金账本。

B：HTTP、冻结授权、审批、证据注册、幂等和资金账本。所有签名前由 ledger.prepare/reserve/beginSigning 再核对资源、收款人、金额、次数、预算、授权版本和撤销状态。IPC 回调绑定当前 run 的 task/plan/auth/memory，证据 ID 不可覆盖、来源闭包经 B 校验。

C：src/signer/worker.ts 仅通过专属父子 IPC 接收约束许可，在进程内生成无资金临时私钥，执行实际 EIP-712 签名与沙箱验签。HTTP 不返回可兑付签名。

三个进程仍运行于同一个 OS 用户，进程与环境隔离不等于容器、文件 ACL 或主机入侵防御。M0 Curator 与其结构回归在 A 中执行，不是独立人工事实裁定服务。

付款使用原子整数字符串与 BigInt，账本采用 SQLite WAL / FULL / 短 BEGIN IMMEDIATE 事务。重复逻辑采购只计一次。签名或发送可能已发生时保留 UNKNOWN 占额；撤销只阻止后续签名和发送，不承诺撤回已有授权。重启不会自动重放整个任务；中断工作流标记失败，已有资金敞口保守保留。

REVIEW 仅绑定当前 request / offer / plan / authorization / TTL 快照。批准不能放宽冻结范围，硬 BLOCK 无审批旁路。资金结算、签名状态、预算由 B 的账本产生，不接受 A 自报成功。

原始外部文本隔离，模型输出保留消费父闭包。经验只允许 BLOCK / REVIEW 条件，经过 origin + 至少 2 个变体 + 2 个良性反例 + 回归后晋升，支持版本检索与回滚。当前标签来自沙箱 oracle，晋升测试是结构回放；正式 heldout 学习增益、功效与成本矩阵尚未运行。

## 测试网与链上组件

兄弟 contracts 目录维护公共 HTTP 接口契约。M0 链上组件复用 Base Sepolia USDC 的 EIP-3009，首版不要求部署自定义 Solidity 合约。

私有 src/payment/x402.ts、src/signer/testnet-*、executeTestnet 和链回执核验实现提供配置入口。HTTP TESTNET 入口在真实集成验收前拒绝启动；只填 RPC 不会开启付款，也不会将模拟收据标记为链上交易。真实钱包、官方资产/domain、受信商家 HTTPS 路由、x402 facilitator 和链回执应一起做带证据的 smoke 后再放行。

官方 SDK 2.28.0 的签名前 abort 钩子有真实 SDK 测试覆盖；C 验证完整 typed-data，B 在 SIGNED 和 DISPATCHED 两个边界先持久化，链确认需要实际 token Transfer + AuthorizationUsed nonce 对应及确认数。

SDK 当前仍依赖 Zod 3.x，npm audit 会报告上游 Zod 风险；不强制跨主版本覆盖 SDK 依赖。受信固定 schema、64 KiB challenge / 256 KiB 资源体限额和仅私有调用缩小暴露面，不能据此声称依赖审计清零或生产安全验收完成。直接 AJV/Zod 依赖已使用修复版本。

## 协作与来源

backend、frontend、contracts 是同一发布仓库中的三个独立 npm 包。公共规范从 contracts 发布，再更新两端 contract.lock.json；vendor 快照保持原始字节，运行时校验 SHA-256。真实数据库、.env、keyfile、日志不提交。

transport-net.ts / transport-body.ts 取自已锁定的 MIT x402check 网络与读取限制实现，文件中保留版权与许可。SDK、LangGraph 和其余依赖以各自上游许可为准。
