# PLAN.md

## Goal
Overhaul Opendum monorepo: Nuxt/Nitro frontend+API → Vite React (`apps/web`) + Hono (`apps/api`); Go proxy → Hono (`apps/proxy`). **All existing logic and functions preserved 1:1** — platform change only. Go tests (18 files) are the parity reference.

Deploy targets: web → Cloudflare Worker (static assets); api + proxy → Railway (Node, `@hono/node-server`).

## Invariants (non-negotiable)
- **AI proxy logic: zero change.** Load balancing, account rotation, quota/points calculation, rate limiting, model resolution, request/response transforms (chat, messages, responses), SSE streaming chunks, error messages/types/codes, HMAC internal auth — all byte-identical behavior. Port only, never "improve".
- **Web UI: zero change.** All components, layout, styling, interactions, copy, states — visually and functionally identical. Framework swap only (Vue→React).
- **API contracts: zero change.** Same routes, same request/response shapes, same auth/session semantics.
- Every ported module must pass a parity check before the phase closes — no exception.

## Approach
1. Baseline: branch, freeze features, snapshot Go behavior + route lists + **golden responses** (normal + streaming + error paths) + web UI screenshots
2. Scaffold monorepo: `apps/web|api|proxy|shared`, shared drizzle schema + registry plugin, root scripts, vitest
3. Deploy setup: verify wrangler Workers static assets + SPA fallback; Hono on Railway; CORS + better-auth `trustedOrigins` (web origin)
4. Port api (Nitro → Hono): 52 routes + 12 services + lib/providers + internal-relay. Lowest risk — logic already TS
5. Port proxy (Go → Hono): config → db → redis → registry → auth → crypto → session → providers → core (load-balancer, quota, points, attempts, streams, transforms) → routes. Port all 18 Go test files to vitest as the safety net
6. Port web (Nuxt → Vite React): lib → src/lib, composables → hooks, reka-ui → radix/shadcn, better-auth/vue → better-auth/react, vite proxy `/api` → api + `/v1` → proxy
7. Wiring: env migration, CI/CD (deploy-web → Cloudflare wrangler, deploy-api + deploy-proxy → Railway), Dockerfiles, delete old `apps/dashboard` + Go proxy
8. Parity: run old vs new side-by-side, diff responses + golden tests + visual diff, cutover — old stack deleted; golden parity carried by 180 vitest cases

## Parity gates (each phase closes only when)
- Proxy: all 18 Go tests ported to vitest and green; golden-file diff (same input → same JSON/stream bytes/status) vs recorded Go responses
- API: 52/52 routes, same shapes, auth/session behavior identical
- Web: visual + functional comparison vs recorded screenshots/interactions, no drift

Order rationale: api first (safest, unblocks web), proxy second (biggest, isolated), web last (depends on api).

## Current Step
Phases 1–7 complete. Legacy Nuxt dashboard + Go proxy removed. 180 vitest parity cases green; live credential parity + DNS cutover remain for the deployment environment.
