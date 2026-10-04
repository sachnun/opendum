# @opendum/proxy

OpenAI-compatible inference proxy. It authenticates API keys, selects a provider
account, transforms requests/responses, streams results back and records usage.

## Structure

| Path | Purpose |
| --- | --- |
| `src/main.ts` | Entry point (env loading, server bootstrap) |
| `src/server.ts` | HTTP server wiring |
| `src/config.ts`, `src/context.ts` | Runtime config and shared context |
| `src/routes/` | HTTP route handlers (`inference`, `models`, `errors`, `internal`) |
| `src/middleware/` | CORS and internal-signature checks |
| `src/core/` | Proxy engine |
| `src/core/service.ts` | `ProxyService`: account selection, rotation, health, usage |
| `src/core/service-helpers.ts` | Pure helpers for health/priority/access rules |
| `src/core/stream.ts`, `sse.ts` | Streaming and SSE plumbing |
| `src/core/points.ts`, `usage.ts`, `ratelimit.ts` | Billing, usage and rate limits |
| `test/` | Vitest integration and unit tests |

## Commands

| Command | Description |
| --- | --- |
| `pnpm dev` | Watch mode via `tsx` |
| `pnpm start` | Run the server |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest |
| `pnpm lint` | ESLint |

## Notes

Provider request/response transforms and endpoint constants live in
`@opendum/providers`; the proxy only orchestrates them.
