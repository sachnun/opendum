# AGENTS.md - Opendum

Guidelines for AI agents working on this Next.js 16 + TypeScript + Prisma codebase.

## Project Overview

Opendum is an OpenAI-compatible API proxy for multiple AI providers. Features:
- OAuth-based provider account management (Iflow, Antigravity, Gemini CLI, Qwen Code)
- Round-robin load balancing across provider accounts
- Proxy API key generation and usage analytics
- GitHub authentication via NextAuth.js

## Commands

```bash
# Development
npm run dev              # Start dev server
npm run build            # Build (runs prisma db push first)
npm run lint             # ESLint

# Database
npx prisma generate      # Generate client after schema changes
npx prisma db push       # Push schema to database
npx prisma migrate dev --name <name>  # Create migration
npx prisma studio        # Database GUI
```

## Testing

No test framework configured. If adding tests, use Vitest:
```bash
npm install -D vitest @vitejs/plugin-react jsdom @testing-library/react
npx vitest run                    # Run all tests once
npx vitest run path/to/file       # Run single test file
npx vitest -t "test name"         # Run tests matching pattern
```

## Project Structure

```
app/
├── (proxy)/v1/         # OpenAI-compatible proxy endpoints
├── api/                # Internal API routes (auth, oauth)
├── dashboard/          # Dashboard pages
└── layout.tsx

components/
├── ui/                 # shadcn/ui components
└── layout/             # Sidebar, header, nav

lib/
├── actions/            # Server actions (accounts, api-keys, analytics)
├── proxy/              # Proxy logic (providers, load-balancer, auth, models)
│   └── providers/      # Provider implementations (iflow, antigravity, etc.)
├── auth.ts             # NextAuth config
├── db.ts               # Prisma singleton
├── encryption.ts       # AES encryption (encrypt/decrypt/hashString)
└── utils.ts            # cn() for classnames

prisma/schema.prisma    # Database schema
```

## Code Style

### Imports
Order: React/Next -> third-party -> internal (`@/lib`, `@/components`)
```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
```

### TypeScript
- Strict mode enabled
- Use `type` for unions/aliases and React props
- Use `interface` for object shapes with methods

```typescript
export type ActionResult<T = void> = 
  | { success: true; data: T }
  | { success: false; error: string };
```

### Naming
- **Files**: kebab-case (`load-balancer.ts`)
- **Components**: PascalCase (`AnalyticsCharts`)
- **Functions**: camelCase (`getValidApiKey`)
- **Constants**: UPPER_SNAKE_CASE (`IFLOW_API_BASE_URL`)

### Server Actions
- Mark with `"use server"` at file top
- Always check auth first
- Return `ActionResult<T>` discriminated union
- Verify ownership before mutations
- Call `revalidatePath()` after mutations

```typescript
"use server";

export async function deleteAccount(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }
  // Verify ownership
  const account = await prisma.providerAccount.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!account) return { success: false, error: "Account not found" };
  
  await prisma.providerAccount.delete({ where: { id } });
  revalidatePath("/dashboard/accounts");
  return { success: true, data: undefined };
}
```

### API Routes
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

### Error Handling
- Wrap DB operations in try/catch
- Log with context: `console.error("Failed to X:", error)`
- Return user-friendly messages (don't expose internals)

### React Components
- Use function declarations
- Client components: `"use client"` directive at top
- Use `cn()` for conditional classNames

### Database & Security
- Use singleton: `import { prisma } from "@/lib/db"`
- Always verify ownership before mutations
- Encrypt sensitive data: `encrypt(token)` from `@/lib/encryption`
- Hash API keys: `hashString(key)` for lookup (SHA-256)
- API key format: `sk-[16 random chars]`

### Styling
- Tailwind CSS v4 with CSS-first config
- Follow shadcn/ui patterns for components
- Use CSS variables for theming (dark mode via `next-themes`)

## Environment Variables

Required in `.env.local`:
```
DATABASE_URL=postgresql://...
NEXTAUTH_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
ENCRYPTION_KEY=...
```

## Key Dependencies

- next: 16.1.5, react: 19.2.3
- prisma: 7.3.0 (PostgreSQL)
- next-auth: 5.0.0-beta.30
- tailwindcss: v4, radix-ui, recharts
