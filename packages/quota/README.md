# @opendum/quota

Fetches and caches provider account quota from upstream providers.

## API

- `registry` - maps a provider to its quota fetcher.
- `fetchers` - per-provider quota fetching.
- `cache` - quota result caching.

## Entry points

| Subpath | Contents |
| --- | --- |
| `@opendum/quota` | Full API |
| `@opendum/quota/types` | Quota types |

## Commands

| Command | Description |
| --- | --- |
| `pnpm test` | Unit tests |
| `pnpm typecheck` | `tsc --noEmit` |
