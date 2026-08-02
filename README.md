# Opendum

Your accounts, one proxy.

Monorepo (npm workspaces) after the Hono/React overhaul:

| App | Stack | Deploy |
| --- | --- | --- |
| `apps/web` | Vite + React 19 + react-router + Tailwind v4 + better-auth/react | Cloudflare Workers (static assets, SPA fallback) |
| `apps/api` | Hono + `@hono/node-server` + drizzle + ioredis + better-auth | Railway (Node) |
| `apps/proxy` | Hono + `@hono/node-server` + drizzle + ioredis (ported from Go) | Railway (Node) |
| `apps/shared` | drizzle schema + model-registry Vite plugin | — |

## Requirements

- Node.js 22+
- PostgreSQL + Redis

## Getting started

```bash
npm install

# env setup
cp apps/api/.env.example apps/api/.env
cp apps/proxy/.env.example apps/proxy/.env
cp apps/web/.env.example apps/web/.env

# run everything (web :5173, api :3001, proxy :4001)
npm run dev

# or individually
npm run dev:web
npm run dev:api
npm run dev:proxy
```

Vite proxies `/api` → api and `/v1` → proxy in development.

## Database

The drizzle schema lives once in `apps/shared/src/db` and is shared by api + proxy.

```bash
npm run db:push    # push schema (drizzle-kit, via apps/api)
npm run db:studio
```

## Tests

```bash
npm test            # api + proxy
npm run test:proxy  # 50 tests, ported from the 18 Go test files
```

## Build & deploy

```bash
npm run build       # web + api + proxy
```

- Web: `wrangler deploy --config apps/web/wrangler.toml` (workflow `.github/workflows/deploy-web.yml`)
- API: Railway via `apps/api/railway.json` (workflow `deploy-api.yml`)
- Proxy: Railway via `apps/proxy/railway.json` (workflow `deploy-proxy.yml`)

## Environment

See each `apps/*/.env.example`. Key vars:

- `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET` — required by api + proxy
- `TRUSTED_ORIGINS` — web origin list for better-auth cross-origin cookies
- `MAINTENERS` — JSON array of maintener emails
- `MODELS_DIR` — model registry JSON directory (auto-detected from repo root)
- `TOKEN_REFRESH_INTERVAL_SECONDS` — proxy token refresher scan interval (0 disables)
- `VITE_PUBLIC_PROXY_URL` — proxy origin shown on the API Keys page

## Model registry

`models/**/*.json` are merged at build/dev time by the shared registry plugin (`apps/shared/src/registry`) for the web app, and loaded at runtime from `MODELS_DIR` by api + proxy. Refresh upstream catalogs with `npm run models:refresh`.
