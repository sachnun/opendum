# @opendum/providers

Provider adapters and the registry that maps providers to request/response transforms.

## Layout

| Path | Purpose |
| --- | --- |
| `src/registry.ts` | Provider registry |
| `src/*.ts` | One adapter per provider |
| `src/*-transform.ts` | Request/response and streaming transforms |
| `src/endpoints.ts` | Canonical provider endpoints and OAuth constants |
| `src/http.ts`, `src/types.ts` | Transport and shared types |

## Entry points

| Subpath | Contents |
| --- | --- |
| `@opendum/providers` | Full API |
| `@opendum/providers/endpoints` | Endpoint and OAuth constants |
| `@opendum/providers/registry` | Registry |
| `@opendum/providers/types`, `http`, `display-names` | Shared pieces |

Endpoint constants live here once and are reused by the dashboard. Do not duplicate
them.

## Commands

| Command | Description |
| --- | --- |
| `pnpm test` | Unit tests |
| `pnpm typecheck` | `tsc --noEmit` |
