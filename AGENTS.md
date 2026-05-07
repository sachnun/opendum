# AGENTS.md

## Commands
- Use `pnpm` only. Root `preinstall` rejects npm/yarn; package manager is `pnpm@10.32.1`.
- Install with `pnpm install --frozen-lockfile` when matching CI/deploy.
- Dashboard dev: `pnpm dev:dashboard` or `pnpm --filter @opendum/dashboard dev`.
- Go proxy dev: `pnpm dev:proxy` or `go -C apps/proxy run ./cmd/proxy`.
- Both dev servers: `pnpm dev` starts dashboard and proxy concurrently.
- Focused dashboard lint: `pnpm --filter @opendum/dashboard lint`. It runs `nuxt prepare` first because ESLint imports generated `.nuxt/eslint.config.mjs`.
- Focused Go proxy tests: `go -C apps/proxy test ./...`; single test: `go -C apps/proxy test ./internal/proxy -run TestName`.
- Root `pnpm lint` means dashboard lint plus Go proxy tests. No separate JS test suite configured.
- Dashboard Cloudflare build: `NITRO_PRESET=cloudflare_module pnpm --filter @opendum/dashboard build`.
- Root `pnpm build` runs dashboard build then `go -C apps/proxy build ./...`. Do not build for verification when change clearly does not need it.
- DB schema push/studio require `DATABASE_URL`: `pnpm db:push`, `pnpm db:studio`. There is no migrations directory; Drizzle pushes from `apps/dashboard/server/lib/db/schema.ts`.
- Model registry refresh: `pnpm models:refresh`. It runs provider scripts from `scripts/models.mjs`, mutates `models/**`, and can partially fail on provider/network issues.

## Layout
- Workspace only includes `apps/*` (`pnpm-workspace.yaml`). `packages/shared` has generated/legacy `dist` artifacts but no active package manifest or source in this workspace.
- `apps/dashboard` is Nuxt 4/Vue app. UI lives in `app/`; API routes live in `server/api`; business logic in `server/services`; database schema/relations in `server/lib/db`.
- `apps/proxy` is separate Go module (`go 1.26`) and runtime proxy. Entry point: `apps/proxy/cmd/proxy/main.go`; HTTP routes: `apps/proxy/internal/api/server.go`; proxy behavior: `apps/proxy/internal/proxy`.
- `models/**/*.toml` is shared source of truth for model metadata. Both dashboard (`server/lib/proxy/loader.ts`) and Go proxy (`internal/models/registry.go`) load it at runtime.
- Dashboard provider implementations are in `apps/dashboard/server/lib/proxy/providers`. Go proxy currently supports API-key providers; `apps/proxy/README.md` lists OAuth-provider parity gaps.

## Env And Runtime
- Dashboard env examples live in `apps/dashboard/.env.example`; proxy env examples in `apps/proxy/.env.example`.
- Shared required runtime env: `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`.
- Dashboard auth also requires `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` when auth module loads.
- Browser playground proxy URL uses `NUXT_PUBLIC_PROXY_URL` first, then legacy `NEXT_PUBLIC_PROXY_URL`.
- Proxy loads root `.env` then `apps/proxy/.env`; defaults `PORT=4001`, `HOST=0.0.0.0`. Set `MODELS_DIR` only if repo-layout autodetect fails.
- `BETTER_AUTH_SECRET` encrypts stored provider credentials. Changing it breaks decryption of existing encrypted data.

## Model Registry Notes
- Canonical model ID is TOML filename. `[opendum].providers`, `[opendum].aliases`, `[opendum].upstream`, and provider tables drive routing and aliases.
- `ignored = true` under `[opendum]` removes a model from effective registries while leaving metadata present.
- Provider-specific table fields `upstream`, `min_tier`, and `aliases` are parsed by both TypeScript and Go loaders; keep semantics aligned when editing loader code.
- Upstream names become reverse aliases; NVIDIA NIM upstream names also get legacy sanitized aliases.

## Deploy
- Dashboard deploy workflow uses Node 24, `pnpm install --frozen-lockfile`, `NITRO_PRESET=cloudflare_module`, then Wrangler from `apps/dashboard` with `deploy --keep-vars`.
- Proxy deploy workflow tests `go -C apps/proxy test ./...`, bundles `models/**` into `.railway-deploy/proxy`, then builds `dist/proxy` with `CGO_ENABLED=0 GOOS=linux GOARCH=amd64` for Railway.
