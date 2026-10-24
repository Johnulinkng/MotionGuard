# Motion Guard 公共契约

当前工作契约版本为 `0.2.0`，由 owner 发布后生效（既有发布快照由 `release-manifest.json` 记录）。`openapi.json` 是唯一接口规范源；状态、授权、REVIEW、金额与 SSE 规则见 [API_GUIDE.md](./API_GUIDE.md)。前后端使用各自 `vendor/contract` 中的只读发布快照和 `contract.lock.json`，不在开发时自动跟随本目录。

需要 Node.js 22.19.0 或更高版本。在本目录运行：

```powershell
npm ci
npm run check
```

`check` 校验 OpenAPI、JSON 引用及 fixtures，再启动临时 mock 执行交互自检。它验证契约和开发工具，不代表后端 provider、安全评测或真实支付验收。

前端独立开发时运行：

```powershell
npm run mock
```

默认地址为 `http://127.0.0.1:4010/api/v1`。mock 只使用 Node 标准库，可直接运行 `node mock-server.mjs`；不需要后端、模型、钱包或 RPC。请求带 `X-Contract-Version: 0.2.0`，mutation 还需 `Idempotency-Key`，已有资源修改需 `If-Match`。创建任务时可使用开发专用 `X-Mock-Scenario: normal|blocked|review|unknown|lesson`。完整请求和状态示例见 `fixtures` 与指南。

mock 的执行模式始终为 `MOCK`，签名和收据均为模拟值；不执行真实认证或链上付款。真实后端默认拒绝上述场景控制头，测试需由进程内选项显式开启。公共 HTTP 不提供 signer、私钥、原始可兑付签名或任意 URL 付款接口。

后端独立验证在 `../backend` 运行：

```powershell
npm run contract:check
npm test
```

`contract:check` 只校验固定快照和 hash；provider、security 与 integration 测试启动真实 `src/server.ts`，使用临时 SQLite 状态，并在测试结束关闭 HTTP 与 signer。是否通过，以实际测试输出为准；缺少模型、RPC 和钱包凭据时，真实模型效果与链上付款仍未验证。

发布由 owner 执行 `../tools/publish_contract.mjs`。同版本发布后不可静默修改接口或 mock；需要变更时先提出版本更新，由前后端分别更新快照、适配和提交。
