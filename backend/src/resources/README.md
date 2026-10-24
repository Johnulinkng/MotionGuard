# 真实只读 ETH 研究资源

入口是 `index.ts`。本模块不持有密钥，不读取 `.env`，不建立付款 offer，不调用 signer 或账本，也不会把外部故障替换为 mock。

`REAL_RESOURCE_CATALOG_VERSION` 为 `public_eth_research_20261024_v1`。`REAL_RESOURCE_CATALOG` 的三个来源都声明 `payTo: null`、`billing.requiresPayment: false`、`amountAtomic: "0"`。

| vendorId | toolId | routeId | 固定能力 |
| --- | --- | --- | --- |
| vendor_base_public | tool_base_sepolia | route_base_sepolia | Base Sepolia 官方 RPC 的链 ID 与最新区块 |
| vendor_llama_price | tool_eth_price | route_eth_price | DefiLlama 的 ETH/USD 报价与供应方时间 |
| vendor_llama_tvl | tool_chain_tvl | route_chain_tvl | DefiLlama 的 Ethereum / Base TVL |

沿用现有规划器的 `selectors.entityIds = [vendorId.replace(/^vendor_/, 'supplier_')]`。getter 只接受已冻结且 hash 匹配的现有 plan，校验 catalogVersion、planItemId、vendor/tool/route、选择器与零价格上限。它不另建规划器，也不修改公共契约。

```ts
const read = await getRealResource({ plan: frozenPlan, planItemId: item.itemId });
if (read.transport !== 'LIVE_HTTP') throw new Error('LIVE_RESOURCE_REQUIRED');
// 将 read.text 原样加入 TOOL_RESPONSE；它仍然是外部不受信数据。
// 本次免费读取不经过任何签名或付款模拟。
```

`text` 包含来源 URL、主要事实、observedAt 和供应方 as-of 时间。`contentHash` 是 text 的 SHA-256；`raw` 仅保留请求相关的、经 schema 校验的字段，`rawContentHash` 对应其 JSON。`sourceResponseHashes` 对应原始 HTTP 响应体，`responseMediaTypes` 保留服务器声明的类型。第三方无关链、报价和额外指令字段不回传。

Base 数据明确标为 **Sepolia 测试网**。报价和链数据允许最多 300 秒未来偏差、最多 3600 秒旧值；超限失败。TVL 接口未提供供应方快照时间，因此 sourceTimestamp 为 null；observedAt 只是读取时间。不同来源的当前快照不构成历史趋势。

每次读取整体超时 10 秒、响应体最多 512 KiB，无自动重试。HTTPS、重定向拒绝、固定 endpoint、连接时 DNS 公网验证和 IP 锁定保持启用。本机系统 DNS 曾给三个域名返回 198.18.0.0/15 的代理 fake IP，因此真实读取使用固定 `https://1.1.1.1/dns-query` bootstrap，只允许解析这三个固定来源域名；DoH 最多 6 秒、16 KiB，并校验 DNS JSON 与所有 A 记录。模型不能提供 endpoint、DoH 地址或待解析域名。

`/v2/chains` 实测把合法 JSON 声明为 `text/html; charset=utf-8`，且 Base 的 tokenSymbol 为 null。仅这个固定路径允许该错误类型声明，仍必须通过 JSON 解析及所需数值字段的 schema 校验；不会执行或渲染 HTML。

带 `fetch` 测试替身的 reader 固定标为 `FIXTURE`。默认测试不请求外网。显式设置 `MOTION_RESOURCES_LIVE=1` 后运行 `test/resources-live.test.ts` 才是真实只读核验。

2026-10-24 的核验保留在 `verification_2026-10-24.json`：最初系统 DNS 0/3 失败；加入固定 DoH 后 Base 与价格各通过一次，TVL 先因错误媒体类型失败，再出现一次原因未核实的临时 unavailable，适配合法 JSON 的声明后 TVL 真实读取通过。三个来源的通过发生在不同时间，不是同一时刻的一次 3/3 运行。

没有配置并核验的 x402 商家；`requireConfiguredX402Merchant()` 抛出 `X402_MERCHANT_UNAVAILABLE`。免费数据不可生成虚构商家地址、收费授权或结算证据。

来源依据（2026-10-24 检查）：

- [Base 官方网络信息](https://docs.base.org/get-started/connect-to-base)：公共 Base Sepolia RPC 与 chain ID 84532。
- [DefiLlama 官方 OpenAPI](https://raw.githubusercontent.com/DefiLlama/api-docs/main/defillama-openapi-free.json)：免费 API 无需密钥，价格路径自己的 server 为 coins.llama.fi；普通 llms-free.txt 的统一 base URL 与此不一致，因此使用 OpenAPI 的路径级 server。
- [Cloudflare 官方 DoH JSON 文档](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/)：固定公共解析服务的请求与响应格式。
