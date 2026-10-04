# @opendum/database

Drizzle ORM client, schema, relations and query functions.

## Entry points

| Subpath | Contents |
| --- | --- |
| `@opendum/database` | Client and table exports |
| `@opendum/database/schema` | Table definitions |
| `@opendum/database/relations` | Drizzle relations |
| `@opendum/database/queries` | Query functions used by services |

## Commands

| Command | Description |
| --- | --- |
| `pnpm db:generate` | Generate a migration from schema changes |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:push` | Push schema directly (local only) |
| `pnpm test` | Unit tests |
| `pnpm typecheck` | `tsc --noEmit` |
