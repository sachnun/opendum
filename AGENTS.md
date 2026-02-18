# Repository Guidelines

## Project Overview
Opendum is a Next.js 16 application (App Router) that proxies LLM API requests across multiple providers. It includes a dashboard for account/key management and analytics, and OpenAI-compatible proxy endpoints.

## Project Structure
- `app/` -- Next.js App Router pages and API routes
  - `app/(landing)/` -- Public marketing/landing pages
  - `app/(proxy)/v1/` -- OpenAI-compatible proxy API routes
  - `app/api/` -- Internal API routes (auth, cron jobs)
  - `app/dashboard/` -- Authenticated dashboard pages
- `components/` -- React components
  - `components/ui/` -- shadcn/ui primitives (auto-generated, do not modify style conventions)
  - `components/dashboard/` -- Dashboard feature components
  - `components/layout/` -- Layout components (sidebar, nav)
  - `components/playground/` -- API playground components
- `lib/` -- Core logic and utilities
  - `lib/actions/` -- Server actions (`"use server"` modules)
  - `lib/db/` -- Drizzle ORM schema (`schema.ts`), relations (`relations.ts`), and connection singleton (`index.ts`)
  - `lib/proxy/` -- Proxy routing, auth, load balancing, rate limiting, error handling
  - `lib/proxy/providers/` -- Per-provider integration logic (one directory per provider)
- `scripts/` -- Model-refresh automation (`refresh-*.mjs`)
- `types/` -- Shared TypeScript type augmentations

## Build, Test, and Development Commands
- `bun install` -- Install dependencies (uses `bun.lock`)
- `bun run dev` -- Start dev server at http://localhost:3000
- `bun run build` -- Run `drizzle-kit push` then `next build`
- `bun run start` -- Run production build
- `bun run lint` -- Run ESLint (flat config: `next/core-web-vitals` + `next/typescript`)
- `bun run lint -- --fix` -- Auto-fix lint issues
- `bun run db:push` -- Push Drizzle schema to database
- `bun run db:studio` -- Open Drizzle Studio GUI
- `bun run models:refresh` -- Refresh provider model maps

### Testing
- No test framework is configured yet.
- **Minimum validation for every change:** run `bun run lint`.
- For new tests, colocate them as `*.test.ts` or `*.test.tsx` beside the file under test.
- Manually verify affected flows (auth, dashboard, proxy endpoints) when possible.

## Code Style

### Formatting
- 2-space indentation, no tabs.
- **Semicolons:** Always use semicolons in application code. The only exception is `components/ui/` files (shadcn/ui auto-generated), which omit them -- leave those as-is.
- **Quotes:** Always double quotes for strings.
- Trailing commas where present in surrounding code.

### Imports
- Use `@/*` path aliases (mapped to project root) instead of long relative paths.
- Use `import type { ... }` for type-only imports.
- **Ordering:** external packages first, then `@/` absolute imports, then relative imports. No blank lines between groups.

```typescript
import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerAccount } from "@/lib/db/schema";
import { getSession } from "@/lib/auth";
import { encrypt } from "@/lib/encryption";
import type { ProviderAccount } from "./types";
```

### Exports
- **Named exports** for everything: functions, components, types, constants.
- **Default exports** only where Next.js requires them: page components, layout components.
- Route handlers export named functions matching HTTP methods: `export async function POST(...)`.

### TypeScript
- Strict mode is enabled (`"strict": true`).
- Prefer `interface` for object shapes; use `type` for unions, aliases, and derived types.
- Type names in `PascalCase`. Generic parameters use single letters (`T`).
- Use `as const` objects instead of enums: `export const ProviderName = { ... } as const;`
- Derive types from Drizzle schemas: `export type User = InferSelectModel<typeof user>;`
- Use type guards for runtime narrowing: `function isFoo(x: string): x is Foo { ... }`

### React Components
- Use **function declarations** (not arrow functions) for component definitions.
- Define a `Props` interface above the component, then destructure in the signature.
- Server components use `async function`. Client components must have `"use client"` at the top.
- Use `cn()` from `@/lib/utils` for conditional Tailwind class merging.

```typescript
interface MyComponentProps {
  title: string;
  className?: string;
}

export function MyComponent({ title, className }: MyComponentProps) {
  return <div className={cn("p-4", className)}>{title}</div>;
}
```

### Server Actions (`lib/actions/`)
- File must start with `"use server";` directive.
- Return `ActionResult<T>` discriminated union -- never throw to the caller.
- Always check auth at the top: `const session = await getSession(); if (!session?.user?.id) return { success: false, error: "Unauthorized" };`
- Use try/catch, log with `console.error("Descriptive prefix:", error)`, return generic error message.
- Call `revalidatePath(...)` after mutations.

```typescript
export type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string };

export async function doThing(id: string): Promise<ActionResult<SomeType>> {
  const session = await getSession();
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }
  try {
    // ... database operation ...
    revalidatePath("/dashboard");
    return { success: true, data: result };
  } catch (error) {
    console.error("Failed to do thing:", error);
    return { success: false, error: "Failed to do thing" };
  }
}
```

### API Route Handlers (`app/(proxy)/`, `app/api/`)
- Set `export const runtime = "nodejs";` and `export const dynamic = "force-dynamic";` at top.
- Return OpenAI-compatible error JSON: `{ error: { message, type, param?, code? } }`.
- Error types: `"authentication_error"`, `"invalid_request_error"`, `"rate_limit_error"`, `"api_error"`, `"configuration_error"`.
- Wrap handler body in try/catch; return 500 with `type: "api_error"` on unhandled errors.

### Error Handling
- Extract error messages safely: `err instanceof Error ? err.message : "Unknown error"`.
- Use `console.error` with a descriptive prefix in catch blocks. No structured logging library.
- For fire-and-forget async operations, use `void someAsyncFn()` or `.catch(() => undefined)`.
- Empty catch blocks are acceptable only for best-effort operations (e.g., cache writes) -- add a comment explaining why.
- Use `lib/proxy/error-utils.ts` utilities (`getErrorMessage`, `getErrorStatusCode`, `getSanitizedProxyError`) in proxy code.

### Async Patterns
- Use `async/await` everywhere (no `.then()` chains in server code).
- Client-side `useEffect` may use `.then()/.finally()` since effect callbacks cannot be async.
- Fire-and-forget: prefix with `void` (e.g., `void touchLastUsed(id);`).

### Database (Drizzle ORM)
- Schema defined in `lib/db/schema.ts`, relations in `lib/db/relations.ts`.
- Connection singleton in `lib/db/index.ts` (uses `globalThis` caching in dev).
- Query pattern: `const [row] = await db.select().from(table).where(and(...)).limit(1);`
- Config: `drizzle.config.ts` (PostgreSQL dialect, schema at `./lib/db/schema.ts`).

### Naming Conventions
- React components and types: `PascalCase`
- Functions, variables, hooks: `camelCase` (hooks prefixed with `use`)
- Route handler files: `route.ts`
- Page files: `page.tsx`, layout files: `layout.tsx`
- Provider directories: `lib/proxy/providers/<provider-name>/`
- Constants objects: `PascalCase` with `as const`

## Environment & Configuration
- Copy `.env.example` to `.env` for local setup. **Never commit secrets.**
- Sensitive variables: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `ENCRYPTION_SECRET`, OAuth client IDs/secrets, `REDIS_URL`.
- UI components managed via shadcn/ui (`components.json`): style `"new-york"`, icon library `lucide`.

## Commit & PR Guidelines
- Conventional commits: `feat(scope): ...`, `fix(scope): ...`, `chore: ...`, `refactor: ...`.
- Imperative mood, focused commits (e.g., `fix(proxy): handle token expiry response`).
- PRs: clear summary, linked issue when available, call out schema/env changes, include screenshots for UI changes.

## Key Dependencies
- **Runtime:** Next.js 16, React 19, Drizzle ORM, better-auth, Redis, CryptoJS
- **UI:** Tailwind CSS 4, shadcn/ui (Radix primitives), Recharts, Lucide icons, Shiki
- **Tooling:** Bun (package manager/runtime), ESLint 9 (flat config), TypeScript 5
