# MotionGuard 前端

React 19、TypeScript 和 Vite 实现的中文任务操作台。包括目标输入、计划确认与冻结、完整报告、公开来源、模型诊断、证据父链、付款复核、预算和只读经验。

完整介绍及真实截图见 [项目首页](../README.md)。

## 真实服务

在后端已经配置并启动的情况下，在本目录执行：

```bash
npm ci
npm run dev
```

页面为 http://127.0.0.1:5173，默认同源代理到后端 4011。模型密钥只由后端读取。前端不直连模型、signer、数据库或账本。

公共接口使用已锁定的 0.2.0 发布快照，TaskResult 提供完整报告与执行模式。免费资料的零付款状态、真实模型和数据模式分别显示，不依据一个 MOCK 标签推断全部运行能力。

## 契约模拟器

```bash
npm run dev:mock
```

该入口在 4010 启动独立模拟器，并为本命令的 Vite 子进程启用场景控件。全部模拟状态持续标记。正常真实后端不会收到 `X-Mock-Scenario`。

## 检查

```bash
npm run check:contract
npm run mock -- --check
npm test
npm run build
```

保持 `dev:mock` 运行后，在另一个终端执行 `npm run test:e2e`，使用系统 Chrome。`test:real:browser` 会创建真实任务并消耗模型 token；`test:real -- --help` 是已有任务的只读核验入口。

配置见 [运行说明](../docs/CONFIGURATION.md)，真实记录与检查边界见 [验证说明](../docs/VALIDATION.md)。
