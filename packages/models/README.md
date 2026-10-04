# @opendum/models

Model registry, catalog data and generated provider metadata.

## Layout

| Path | Purpose |
| --- | --- |
| `data/` | Hand-authored catalog input |
| `generated/` | Derived output, committed and refreshed by CI |
| `scripts/` | Refresh and enrichment scripts |
| `src/` | Registry, canonicalization, families, probes, runtime types |

## Entry points

| Subpath | Contents |
| --- | --- |
| `@opendum/models` | Registry API |
| `@opendum/models/runtime` | Runtime `Registry` and model types |
| `@opendum/models/registry` | Registry implementation |
| `@opendum/models/clean-key`, `families`, `merge`, `probes` | Helpers |

## Commands

| Command | Description |
| --- | --- |
| `pnpm refresh` | Regenerate `generated/` from `data/` |
| `pnpm test` | Unit tests |
| `pnpm typecheck` | `tsc --noEmit` |

Never edit `generated/` by hand; the scheduled workflow refreshes it.
