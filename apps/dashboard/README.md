# @opendum/dashboard

Nuxt 4 single-page admin UI plus its Nitro server API (control plane).

## Structure

| Path | Purpose |
| --- | --- |
| `app/` | Nuxt `srcDir` (client + shared UI) |
| `app/components/` | Vue components, grouped by feature (`ui/`, `account/`, `api-key/`, `model/`, ...) |
| `app/composables/` | Auto-imported Vue composables |
| `app/pages/`, `app/layouts/` | File-based routes and layouts |
| `app/middleware/` | Route middleware |
| `app/utils/` | Small auto-imported helpers |
| `lib/` | Framework-agnostic helpers shared by client and server (unit-tested) |
| `server/api/` | Nitro HTTP endpoints (file-based routing) |
| `server/services/` | Domain services (database access, business rules) |
| `server/lib/` | Server integrations (provider clients, proxy relay, encryption) |
| `server/middleware/`, `server/utils/` | Nitro middleware and per-request helpers |

Components are auto-imported by file name (`pathPrefix: false`), so folders are for
people, not for import paths.

## Where does a helper go?

| Kind | Location |
| --- | --- |
| Small helper used by components, no framework dep | `app/utils/` |
| Reactive/Vue composable | `app/composables/` |
| Framework-agnostic helper used by both client and server | `lib/` |
| Server-only request helper (auth, parsing) | `server/utils/` |
| Database/business logic | `server/services/` |
| External service integration | `server/lib/` |

Prefer one rule over spreading the same helper across folders. `lib/` is intentionally
outside `app/` so it is not auto-imported and stays unit-testable.

## Commands

| Command | Description |
| --- | --- |
| `pnpm dev` | Nuxt dev server |
| `pnpm build` | Production build |
| `pnpm typecheck` | `vue-tsc` over the generated Nuxt app and server projects |
| `pnpm lint` | `nuxt prepare` + ESLint |
| `pnpm test` | Unit tests (`lib/*.test.ts`) and Nuxt component tests (`tests/nuxt/*.spec.ts`) |
| `pnpm test:unit` | Unit tests only |
| `pnpm test:nuxt` | Component tests only (Vitest + `@nuxt/test-utils`) |

## Testing

| Kind | Location | Runner |
| --- | --- | --- |
| Pure helper unit tests | `lib/*.test.ts` | `tsx --test` |
| Component tests | `tests/nuxt/*.spec.ts` | Vitest (`environment: "nuxt"`) |

Component tests use `mountSuspended` from `@nuxt/test-utils/runtime`; `tests/setup.ts`
installs `fake-indexeddb` because happy-dom has no IndexedDB.

## Notes

- Imports inside `server/` use `~~/server/...`, and shared helpers use `~~/lib/...`.
- The Redis `xxhash` digest command is stubbed during build (see `nuxt.config.ts`).
