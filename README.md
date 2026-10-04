# opendum

A self-hosted AI gateway: a streaming inference proxy plus an admin dashboard for
managing provider accounts, API keys, models, quota and usage.

## Layout

| Path | Purpose |
| --- | --- |
| `apps/dashboard` | Nuxt 4 SPA + Nitro server API (admin UI and control plane) |
| `services/proxy` | OpenAI-compatible inference proxy (data plane) |
| `packages/*` | Shared libraries consumed by both runtimes |

### Packages

| Package | Responsibility |
| --- | --- |
| `@opendum/config` | Environment schema (Zod) and env loading |
| `@opendum/crypto` | Encryption, signatures, CryptoJS interop |
| `@opendum/database` | Drizzle client, schema, queries, migrations |
| `@opendum/models` | Model registry, catalog data and generated metadata |
| `@opendum/providers` | Provider adapters (request/response transforms, endpoints) |
| `@opendum/quota` | Provider quota fetchers and registry |
| `@opendum/egress` | SSRF guard and egress proxy helpers |
| `@opendum/redis` | Redis client, key helpers, session affinity |
| `@opendum/auth` | Better-Auth setup and custom store |

## Dependency direction

Dependencies point downward; lower layers never import upper ones.

```
config, crypto, database, models   (no internal deps beyond themselves)
redis, egress                      -> config
providers                          -> config, database, egress, models, redis
auth                               -> crypto, database, models, redis
services/proxy                     -> all of the above
apps/dashboard                     -> auth, database, models, providers, redis
```

## Requirements

- Node.js 24
- pnpm 12 (see `packageManager` in `package.json`)
- PostgreSQL and Redis for local runs

## Commands

| Command | Description |
| --- | --- |
| `pnpm dev` | Run dashboard and proxy together |
| `pnpm build` | Build dashboard and typecheck proxy |
| `pnpm db:generate` / `db:migrate` / `db:push` | Drizzle workflow |
| `pnpm models:refresh` | Regenerate the provider model registry |
| `pnpm --filter <pkg> test` | Run a workspace test suite |
| `pnpm --filter <pkg> typecheck` | Typecheck a workspace |

## Conventions

- Every package exposes an explicit `exports` map; import through public subpaths,
  not into `src/` files directly.
- Provider endpoints live once in `@opendum/providers/endpoints` and are reused by
  the dashboard; do not duplicate endpoint constants.
- Unit tests are colocated (`*.test.ts`); the proxy keeps integration tests in `test/`.
- Inside the dashboard, use the Nuxt aliases (`~/`, `~~/`, `~~/server/...`) rather
  than deep relative paths.
- `packages/models/generated/` is committed and refreshed automatically by
  `.github/workflows/models.yml`; treat it as build output and never edit by hand.

## Model registry

`packages/models/data/` holds hand-authored catalog input. `packages/models/generated/`
is derived output committed for deterministic deploys. The scheduled `Refresh Provider
Models` workflow regenerates and commits it every 5 hours.

## CI

`.github/workflows/ci.yml` runs on every pull request: dashboard lint/typecheck/build,
proxy typecheck/test, and typecheck/test for the shared packages.
