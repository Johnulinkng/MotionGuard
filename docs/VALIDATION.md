# 验证记录

日期：2026-10-24，Asia/Shanghai。真实运行与隔离测试分别记录，不能相互替代。

## 已完成的真实任务

任务 `task_4a343fa12f4240ee8b6c67e6d8d6c14e` 从浏览器创建，选择三个来源、确认计划和授权后执行，约 15.17 秒完成。这是一次本机观测，不是延迟保证。

8 次真实 `deepseek-flash` 调用均返回 HTTP 200 和 `SUCCEEDED`，输入 7229、输出 778、总计 8007 tokens。3 个真实来源、13 条证据、27 条 SSE 均已核对；报告 1074 字符，页面和导出与公共 TaskResult 全文一致。

独立验证者复用同一个任务，只发 GET，核对来源/报告哈希、引用父闭包、三源可达性及有效 JSON。两次核验的 model callId 一致，没有重跑模型。Base Sepolia chainId 为 84532；价格和 TVL 是有时间标注的快照，TVL 提供方未给出其数据时点。

本任务 `paidCalls=0`、PaymentList 为空，settled/reserved/outstanding 均为 0。没有真实签名或链上实付。`NO_ONLINE_LABELS` 未触发经验整理或自动晋升；已有沙箱经验不计作本轮学习成果。

公开证据：

- [任务、报告、来源和安全模型诊断](evidence/real-task.json)
- [独立公共 API 核验](evidence/verification.json)
- [只读截图记录](evidence/screenshot-capture.json)
- [源码提交与截图 SHA-256](SOURCE_PROVENANCE.json)

截图为浏览器原始画面，没有修改图片或临时改造 UI 来制造成功状态。拍摄只发 GET，新增任务和模型调用均为 0。390px 页面无横向溢出；刷新新增 POST 为 0。

## 发布副本的干净安装检查

在将要上传的独立 checkout 中，分别执行三个目录的 `npm ci --no-audit --no-fund` 后验证：

| 检查 | 结果 |
| --- | --- |
| 前端 `npm test` | 127/127，通过 |
| 前端 `npm run build` | TypeScript + Vite，通过 |
| 前端 `npm run check:contract` | 0.2.0、16 文件原始字节 hash，通过 |
| 后端 `npm run check` | 121 项：118 通过、0 失败、3 项显式联网 opt-in 跳过 |
| 契约 `npm run check` | 19 operations、30 schemas、12 fixtures；12/12 测试、195 项模拟器断言，通过 |

另外，原开发副本的 Chrome 模拟器回归为 14/14（22.8 秒），覆盖授权、复核、UNKNOWN、会话、并发/迟到响应和手机布局。这组使用明确的契约模拟器，不能当真实模型或实付证明。上述离线检查不读取模型密钥，也没有新增模型调用。

模型调用或来源失败不会回填固定演示结果。测试覆盖了伪造证据、引文错序、密钥回显、取消后的晚事件，以及签后未知状态保守占额等边界。它们不构成统计攻击防护或学习效果结论。

## 如何复核

源码检查可从项目根执行：

```bash
npm --prefix contracts run check
npm --prefix backend run check
npm --prefix backend run contract:check
npm --prefix frontend run check:contract
npm --prefix frontend test
npm --prefix frontend run build
```

浏览器模拟回归：在一个终端启动 `npm --prefix frontend run dev:mock`，另一个终端执行 `npm --prefix frontend run test:e2e`，需系统 Chrome。

真实模型及资料配置后，可以执行 `npm --prefix frontend run test:real:browser` 创建并运行新任务；该命令会消耗模型额度。已有任务可只读核验：

```bash
npm --prefix frontend run test:real -- --task-id=task_ID --source-host=coins.llama.fi --source-host=api.llama.fi --rpc-host=sepolia.base.org
```

文档中的历史 task ID 只用于公开证据，新 clone 没有其运行数据库，不能直接从本机 API 查到它。应先自行运行任务，再复核新 ID。

## 已知范围

当前 HTTP 付款仍为 MOCK，真实 TESTNET 入口关闭，无钱包/商家实付证据。后端 x402 SDK 的传递依赖仍有上游 Zod 3.x 审计风险；本轮未强行跨主版本覆盖，也不宣称依赖审计清零或生产安全验收完成。

源码中的网络限额、schema 验证和私有调用缩小暴露面，不能替代上游修复和后续复验。依赖按 lockfile 安装，许可证与改编声明见 [第三方声明](../THIRD_PARTY_NOTICES.md)。
