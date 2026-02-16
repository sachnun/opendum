# Repository Guidelines

## Project Structure & Module Organization
- `app/`: Next.js App Router entrypoints, including landing pages, dashboard pages, and proxy API routes under `app/(proxy)/v1/*`.
- `components/`: Reusable UI and feature components (`dashboard/`, `layout/`, `playground/`, `ui/`).
- `lib/`: Core logic, including server actions (`lib/actions`), provider integrations (`lib/proxy/providers`), auth, DB, and caching utilities.
- `prisma/`: Database schema and SQL migrations.
- `scripts/`: Model-refresh automation (`scripts/refresh-*.mjs`).
- `types/`: Shared TypeScript type augmentations.

## Build, Test, and Development Commands
- `bun install`: Install dependencies from `bun.lock`.
- `bun run dev`: Start local development server at `http://localhost:3000`.
- `bun run build`: Run `prisma db push` and build production assets.
- `bun run start`: Run the production build locally.
- `bun run lint`: Run ESLint (`next/core-web-vitals` + TypeScript rules).
- `bun run models:refresh`: Refresh provider model maps used by proxy routing.

## Coding Style & Naming Conventions
- Use TypeScript with strict typing (`tsconfig.json` has `"strict": true`).
- Prefer `@/*` path aliases over long relative imports (example: `@/lib/db`).
- Follow existing file formatting (2-space indentation, trailing commas where present, semicolon style consistent within file).
- Naming: React components in `PascalCase`, hooks in `camelCase` with `use` prefix, route handlers in `route.ts`, provider-specific logic in `lib/proxy/providers/<provider>/`.

## Testing Guidelines
- There is currently no dedicated unit/e2e test suite in this repo.
- Minimum validation for each change: run `bun run lint`.
- Minimum validation for each change: manually verify affected flows (auth, dashboard, and/or proxy endpoints).
- For new tests, prefer colocated files named `*.test.ts` or `*.test.tsx`.

## Commit & Pull Request Guidelines
- Match existing commit style: `feat(scope): ...`, `fix(scope): ...`, `chore: ...`, `refactor: ...`.
- Keep commits focused and written in imperative mood (example: `fix(iflow): handle token expiry response`).
- PRs should include a clear summary and motivation.
- PRs should include a linked issue when available.
- PRs should call out schema/env changes (`prisma/schema.prisma`, `.env.example`).
- PRs should include screenshots or short recordings for UI updates.

## Security & Configuration Tips
- Copy `.env.example` to `.env` for local setup; never commit secrets.
- Treat OAuth credentials, API keys, and `NEXTAUTH_SECRET` as sensitive.
- Review Prisma changes carefully and include migrations when schema behavior changes.
