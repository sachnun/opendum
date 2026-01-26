# AGENTS.md - iFlow Proxy

Guidelines for AI agents working on this Next.js 16 + TypeScript + Prisma codebase.

## Project Overview

iFlow Proxy is a Next.js application that provides an OpenAI-compatible API proxy for iFlow AI services. It features:
- OAuth-based iFlow account management
- Round-robin load balancing across multiple iFlow accounts
- Proxy API key generation and management
- Usage analytics dashboard
- GitHub authentication via NextAuth.js

## Build, Lint, and Dev Commands

```bash
# Development
npm run dev          # Start dev server (next dev)

# Build
npm run build        # Production build (next build)
npm run start        # Start production server

# Linting
npm run lint         # Run ESLint

# Database (Prisma)
npx prisma generate  # Generate Prisma client
npx prisma db push   # Push schema changes
npx prisma migrate dev --name <migration_name>  # Create migration
npx prisma studio    # Open database GUI
```

## Testing

No test framework is currently configured. If adding tests, use Vitest:
```bash
# Install
npm install -D vitest @vitejs/plugin-react jsdom @testing-library/react

# Run tests (after setup)
npx vitest                    # Run all tests in watch mode
npx vitest run                # Run all tests once
npx vitest run path/to/file   # Run single test file
npx vitest -t "test name"     # Run tests matching pattern
```

## Project Structure

```
app/                    # Next.js App Router
├── (proxy)/v1/         # OpenAI-compatible API routes
│   ├── chat/completions/  # Chat completions endpoint
│   ├── messages/          # Messages endpoint
│   └── models/            # Models endpoint
├── api/                # Internal API routes (auth, oauth)
├── dashboard/          # Dashboard pages (accounts, api-keys)
└── page.tsx            # Landing page

components/
├── ui/                 # shadcn/ui components
├── layout/             # Layout components (sidebar, header)
└── theme-provider.tsx  # Theme context

lib/
├── actions/            # Server actions (accounts, api-keys, analytics)
├── proxy/              # Proxy logic (iflow-client, load-balancer, auth)
├── auth.ts             # NextAuth configuration
├── db.ts               # Prisma client singleton
├── encryption.ts       # AES encryption utilities
└── utils.ts            # Utility functions (cn for classnames)

prisma/
├── schema.prisma       # Database schema
└── migrations/         # Database migrations
```

## Code Style Guidelines

### Imports
- Use path aliases: `@/*` maps to project root
- Order: React/Next → third-party → internal (`@/lib`, `@/components`)
- Use named imports for components and utilities

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Button } from "@/components/ui/button";
```

### TypeScript
- Strict mode enabled (`"strict": true`)
- Always type function parameters and return values for public APIs
- Use interfaces for object shapes, types for unions/aliases
- Prefer `type` for React component props

```typescript
export type ActionResult<T = void> = 
  | { success: true; data: T }
  | { success: false; error: string };

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}
```

### Naming Conventions
- **Files**: kebab-case (`iflow-client.ts`, `load-balancer.ts`)
- **Components**: PascalCase (`Button`, `AnalyticsCharts`)
- **Functions**: camelCase (`getValidApiKey`, `buildRequestPayload`)
- **Constants**: UPPER_SNAKE_CASE (`IFLOW_API_BASE_URL`, `REFRESH_BUFFER_SECONDS`)
- **Server Actions**: camelCase verbs (`createApiKey`, `deleteIflowAccount`)

### React Components
- Use function declarations for components
- Client components: add `"use client"` directive at top
- Server components: default (no directive needed)
- Use `cn()` utility for conditional classNames

```typescript
function Button({ className, variant, ...props }: ButtonProps) {
  return (
    <button className={cn(buttonVariants({ variant }), className)} {...props} />
  );
}
```

### Server Actions
- Mark with `"use server"` at file top
- Always check authentication first
- Return `ActionResult<T>` discriminated union
- Use `revalidatePath()` after mutations

```typescript
"use server";

export async function deleteAccount(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }
  // ... implementation
  revalidatePath("/dashboard/accounts");
  return { success: true, data: undefined };
}
```

### Error Handling
- Wrap database operations in try/catch
- Log errors with `console.error()` including context
- Return user-friendly error messages (don't expose internals)
- For API routes, return structured error responses

```typescript
try {
  await prisma.account.delete({ where: { id } });
  return { success: true, data: undefined };
} catch (error) {
  console.error("Failed to delete account:", error);
  return { success: false, error: "Failed to delete account" };
}
```

### API Routes
- Export `runtime = "nodejs"` for routes using Node.js APIs
- Export `dynamic = "force-dynamic"` for non-cacheable routes
- Validate Authorization header with `validateApiKey()`
- Return JSON errors with consistent structure

```typescript
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const authResult = await validateApiKey(request.headers.get("authorization"));
  if (!authResult.valid) {
    return NextResponse.json(
      { error: { message: authResult.error, type: "authentication_error" } },
      { status: 401 }
    );
  }
  // ...
}
```

### Database (Prisma)
- Use the singleton from `@/lib/db`
- Always verify ownership before mutations
- Use indexes for frequently queried fields (see schema)
- Sensitive data (tokens, keys) must be encrypted with `encrypt()`

### Encryption
- Use `encrypt()`/`decrypt()` from `@/lib/encryption` for sensitive data
- Use `hashString()` for API key lookup (SHA-256)
- API keys use format: `ifp_[48 random chars]`

### Styling
- Tailwind CSS v4 with CSS-first configuration
- Use `tw-animate-css` for animations
- Follow shadcn/ui patterns for new components
- Use CSS variables for theming (dark mode via `next-themes`)

## Environment Variables

Required in `.env.local`:
```
DATABASE_URL=postgresql://...
NEXTAUTH_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
IFLOW_CLIENT_ID=...       # Optional, has defaults
IFLOW_CLIENT_SECRET=...   # Optional, has defaults
```

## Key Libraries

- **next**: 16.1.5 (App Router)
- **react**: 19.2.3
- **prisma**: 7.3.0 with PostgreSQL adapter
- **next-auth**: 5.0.0-beta.30
- **tailwindcss**: v4
- **radix-ui**: For accessible UI primitives
- **recharts**: For analytics charts
- **crypto-js**: For encryption
