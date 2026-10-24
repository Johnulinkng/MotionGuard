# Third-party notices

This repository preserves upstream copyright and license notices. It does not declare the entire project to be MIT-licensed.

## Adapted source

`backend/src/payment/transport-net.ts` and `backend/src/payment/transport-body.ts` include portions adapted from `caiovicentino/jev-risk-check-provider`, commit `5d894da4aa44d2bed9e47f42c8e9a70f2978975b`. Both files retain the complete MIT license, copyright and disclaimer. Local changes constrain transport, response bodies and private payment execution; no hosted risk service is required.

## Dependencies

Dependencies are installed from each package's lockfile; their own licenses and notices continue to apply.

| Dependency | License |
| --- | --- |
| LangGraph JS, viem, undici, AJV, Zod | MIT |
| React, Phosphor Icons, Vite | MIT |
| x402 SDK, TypeScript, Playwright | Apache-2.0 |
| Manrope font | SIL Open Font License 1.1 |

Source publication excludes `node_modules` and generated builds. Distributing bundled third-party code or fonts requires preserving their applicable licenses and notices.
