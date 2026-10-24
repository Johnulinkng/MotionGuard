# 配置与运行

## 真实模型与资料

三个目录分别安装依赖；仓库根没有统一 npm workspace。共同运行环境为 Node.js 24+。

首次运行才复制 `backend/.env.example` 为 `backend/.env`，避免覆盖已有本地配置。填写 DeepSeek 密钥，保持以下模式：

```dotenv
MOTION_LLM_BASE_URL=https://api.deepseek.com
MOTION_LLM_MODEL=deepseek-flash
MOTION_LLM_API_KEY=your_deepseek_key
MOTION_LLM_MODE=real
MOTION_RESOURCE_MODE=live
MOTION_ENABLE_DEMO_SCENARIOS=0
MOTION_EXECUTION_MODE=MOCK
```

`MOTION_EXECUTION_MODE` 描述付款。它保持 MOCK 不会把真实模型或真实资料变成模拟。真实配置不完整、模型限流、响应无效或资料读取失败时，任务会失败并保留诊断，不自动回退。

在后端目录运行 `npm run preflight` 只检查配置存在性与契约。`npm run preflight -- --check-model` 会发起一次真实模型探针并消耗额度；`--check-rpc` 会只读核对 Base Sepolia chainId。

默认监听 `127.0.0.1:4011`。前端 `npm run dev` 监听 `127.0.0.1:5173`，默认代理到 4011；可在启动前设置公开配置 `MOTION_API_TARGET`。前端不需要模型密钥。

## Operator 会话

本机未设置 `MOTION_OPERATOR_TOKEN` 时，付款沙箱的身份模式为 `MOCK_UNAUTHENTICATED`。设置后，公共业务请求需要对应 Bearer；在页面的连接设置中填写 Operator session。

会话只放在浏览器内存，不写入 URL、localStorage、sessionStorage 或导出文件。刷新后需要重新输入。非回环监听必须有 Operator token，并配置 `MOTION_ALLOWED_ORIGINS`；CORS 本身不是身份验证。

## 离线契约演示

不使用模型或后台时，在前端目录执行：

```bash
npm run dev:mock
```

该入口启动 4010 契约模拟器和 5173 页面，明确显示模拟模型、资料和付款。它与真实入口二选一，端口占用不会替换正在运行的服务。

`dev:backend` 是另一个隔离沙箱测试工具，关闭模型环境配置，不是正常 DeepSeek 入口。真实后端关闭开发场景时，不应运行 `test:live` 五场景演示。

## 运行数据

数据库、密钥、签名材料、日志和浏览器测试产物均在 `.gitignore` 中。仓库不包含展示任务的运行数据库；`docs/evidence/` 只保留经检查的公开结果与核验记录。新 clone 需配置自己的模型密钥并创建任务。

付款实链另需专用测试钱包、测试资金、受信商家路由及 facilitator，并完成 nonce/回执核验。只配置模型密钥或 RPC 不会启用付款。
