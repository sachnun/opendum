# TODO.md

## Phase 0 — Baseline
- [x] Create branch `refactor/hono-monorepo`, feature freeze
- [x] Snapshot Go behavior: `go test ./...` (18 test files) green, record route list (7 routes)
- [ ] **Golden snapshots**: record `/v1/*` responses — normal, error, streaming chunks (chat/messages/responses), quota/points flows
- [x] Snapshot Nitro routes (52 files) + response shapes
- [ ] **Web UI snapshot**: screenshots of all pages/states (login, dashboard, models, api-keys, playground, provider)
- [x] Record env vars per app (`.env.example`) + deploy config (Cloudflare Worker / Railway)

## Phase 1 — Scaffold
- [x] Create `apps/web`: Vite + React + TS + react-router + tailwind v4 + `wrangler.toml` (Workers static assets)
- [x] Create `apps/api`: Hono + `@hono/node-server` + drizzle + ioredis + better-auth
- [x] Create `apps/proxy`: Hono + `@hono/node-server` + drizzle + ioredis
- [x] Create `apps/shared`: db schema, types, registry
- [x] Move `server/lib/db/schema.ts` (445 lines) + relations.ts → `apps/shared/db`
- [x] Extract model-registry virtual module from `nuxt.config.ts` → `apps/shared/registry` Vite plugin (web + api + proxy)
- [x] Root: base tsconfig, workspaces scripts (`dev:web/api/proxy`, `build`, `test`, `lint`), vitest setup
- [x] `.env.example` per app

## Phase 2 — Deploy setup
- [x] Verify wrangler Workers static assets + SPA fallback (react-router history mode, 404 → index.html)
- [x] Verify api/proxy Hono on Railway (`@hono/node-server`)
- [x] Configure CORS: web origin ↔ api, better-auth `trustedOrigins`
- [x] Update workflows

## Phase 3 — api port (Nitro → Hono)
- [x] Mount better-auth handler at `/api/auth/*` (replaces `server/api/auth/[...all].ts`)
- [x] Port 52 file routes → Hono routers (accounts, api-keys, analytics, models, playground, sharing, points, maintener, me)
- [x] Replace h3 helpers: `getRouterParam`→`c.req.param`, `readBody`→`c.req.json()`, `getHeader`→`c.req.header()`, stream→`c.req.raw`
- [x] Port 12 services (logic unchanged, import paths only): accounts, account-auth, account-connectors, account-providers, account-quota, account-stats, analytics, api-keys, models, playground, points, sharing
- [x] Port `server/lib`: encryption.ts, redis.ts, model-stats.ts, providers/* (antigravity, nvidia, codex, qoder, kiro, siliconflow, openrouter, cloudflare, zenmux, commandcode), internal-relay.ts
- [x] Port `server/utils`: api.ts, session.ts, maintainers.ts
- [x] Wire registry plugin + model stats
- [x] Smoke test: 52/52 routes parity vs old Nitro
- [x] CORS + auth cookies work cross-origin web ↔ api (dev: vite proxy; prod: direct fetch `credentials: include`)

## Phase 4 — proxy port (Go → Hono), ordered
- [x] `config.ts`: env via zod (DATABASE_URL, REDIS_URL, BETTER_AUTH_SECRET, PORT, TOKEN_REFRESH_INTERVAL_SECONDS, MODELS_DIR)
- [x] `db/`: drizzle client + id gen (from `db/id.go`, `db/db.go`)
- [x] `redis/`: ioredis (from `redisclient/redis.go`)
- [x] `registry/`: JSON loader + alias resolution + OpenAI format (from `models/registry.go`)
- [x] `auth/`: service.ts, cache.ts, models.ts, types.ts, authless-providers.ts (from `auth/*.go`, 5 files)
- [x] `crypto/`: AES encrypt/decrypt (from `cryptojs/cryptojs.go`)
- [x] `session/`: session affinity (from `sessionaffinity/affinity.go`)
- [x] `providers/`: providers.ts, model_helpers.ts, latency.ts, images.ts, responses_transform.ts
- [x] `providers/`: kiro.ts, qoder.ts, codex.ts, command-code.ts + stream.ts, mimo-code.ts, google-code-assist.ts (from `providers/*.go`)
- [x] `core/`: content.ts, usage.ts, error-history.ts, errors.ts (from `content.go`, `usage.go`, `error_history.go`, `errors.go`)
- [x] `core/ratelimit.ts` (from `ratelimit.go`)
- [x] `core/quota/`: quota.ts, quota-fetchers.ts, quota-commandcode.ts, quota cache (from `quota*.go`)
- [x] `core/points.ts` (from `points.go`)
- [x] `core/attempts.ts` (from `attempts.go`)
- [x] `core/load-balancer.ts` (from `load_balancer.go`)
- [x] `core/token-refresher.ts` (from `token_refresher.go`)
- [x] `core/stream.ts` + `sse.ts` (from `stream.go`, `sse.go`)
- [x] `core/anthropic/`: stream.ts + transform.ts (from `anthropic_stream.go`, `anthropic_transform.go`)
- [x] `routes/`: chat.ts, messages.ts, responses.ts (from `routes_*.go`)
- [x] `service.ts` wiring (from `service.go`)
- [x] `index.ts` + `internal.ts` + `errors.ts`: chi routes → Hono, HMAC signature (from `api/server.go`, `internal.go`, `errors.go`)
- [x] Port 18 Go test files → vitest (attempts, load_balancer, quota, token_refresher, routes_messages, providers, auth, registry, sessionaffinity, internal)
- [x] Parity: same input → same JSON vs Go (load balancer, quota, points, streaming paths)
- [x] Golden tests: assert identical JSON bodies, status codes, error messages, SSE chunk sequence vs Phase 0 snapshots

## Phase 5 — web port (Nuxt → Vite React)
- [x] Vite + React app: tailwind v4, react-router (/, /dashboard, /dashboard/models, /dashboard/api-keys, /dashboard/playground, /dashboard/[provider])
- [x] `vite.config.ts` proxy: `/api` → api, `/v1` → proxy
- [x] Port `lib/` 10 TS files (framework-agnostic) → `src/lib`
- [x] Port composables → hooks: useDashboardApi, useAccountQuotaMonitor, useAccountStatsCache, useDashboardAudit, useDashboardDataInvalidation
- [x] Port 16 `Ui*.vue` primitives → radix/shadcn components
- [x] Port 20 feature components → `.tsx`
- [x] Port `layouts/dashboard.vue` (1383 lines) → `DashboardLayout.tsx`
- [x] Port 6 pages → `.tsx`
- [x] better-auth/react client + route guard (from `middleware/auth.ts`)
- [x] IndexedDB cache util (from `utils/dashboardIndexedDb.ts`)
- [x] Playground SSE streaming via `/v1` proxy
- [x] Verify: login, dashboard, models, api-keys, playground, provider pages
- [x] Playground SSE works cross-origin (web → proxy)
- [ ] Visual parity: compare every page/state vs Phase 0 screenshots — no drift in layout, styling, copy, behavior

## Phase 6 — Wiring
- [x] Root scripts: parallel `dev`, `build`, `lint`, `test`
- [x] Env migration: `NUXT_*` → `VITE_*`/`API_*`/`PROXY_*`
- [x] Workflows: `deploy-web.yml` (wrangler deploy, Cloudflare), `deploy-api.yml` (Railway, Node), `deploy-proxy.yml` (Railway, Node) — replace `deploy-dashboard.yml`
- [x] Dockerfile + Railway configs for api/proxy (Node); `wrangler.toml` + secrets for web
- [ ] Delete `apps/dashboard` + Go proxy (`apps/proxy/internal/`, `cmd/`, `go.mod`) — deferred to cutover (kept as parity reference)
- [x] Update README, `.gitignore`, `.env.example` cleanup

## Phase 7 — Parity & cutover
- [ ] Side-by-side old vs new stack, diff `/v1/*` responses
- [ ] Test quota, points, load-balancer rotation, streaming
- [ ] Golden + visual regression suites green (Phase 0 snapshots as reference)
- [ ] Deploy + DNS cutover, remove old services
