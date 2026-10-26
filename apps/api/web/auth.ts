import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, bearer, jwt } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { db as defaultDb, schema, user, type Database } from "@opendum/database";
import { ensureBalance } from "./services/points.js";
import { roleOf as maintainerRole } from "./utils/maintainers.js";

export const ACCESS_TOKEN_TTL = "7d";
export const ACCESS_TOKEN_ISSUER = "opendum";
export const ACCESS_TOKEN_AUDIENCE = "opendum";
export const ADMIN_ROLE = "admin";
export const USER_ROLE = "user";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function roleOf(email: string | null | undefined): string {
  return maintainerRole(email) === "maintainer" ? ADMIN_ROLE : USER_ROLE;
}

export function createAuth(db: Database = defaultDb, options: { baseURL?: string } = {}) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        ...schema,
      },
    }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: options.baseURL ?? process.env.BETTER_AUTH_URL,
    trustedOrigins: ["*"],
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"],
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (createdUser) => {
            return { data: { ...createdUser, role: roleOf(createdUser.email) } };
          },
          after: async (createdUser) => {
            try {
              await ensureBalance(createdUser.id);
            } catch (error) {
              console.error("Failed to initialize point balance:", error);
            }
          },
        },
      },
      session: {
        create: {
          before: async (createdSession) => {
            const [found] = await db
              .select({ id: user.id, email: user.email, role: user.role })
              .from(user)
              .where(eq(user.id, createdSession.userId))
              .limit(1);
            if (!found) return;

            const role = roleOf(found.email);
            if (found.role !== role) {
              await db.update(user).set({ role }).where(eq(user.id, found.id));
            }
          },
        },
      },
    },
    emailAndPassword: {
      enabled: process.env.NODE_ENV === "development",
    },
    socialProviders: {
      github: {
        clientId: requireEnv("GITHUB_CLIENT_ID"),
        clientSecret: requireEnv("GITHUB_CLIENT_SECRET"),
      },
      google: {
        clientId: requireEnv("GOOGLE_CLIENT_ID"),
        clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
      },
    },
    plugins: [
      bearer(),
      jwt({
        jwt: {
          issuer: ACCESS_TOKEN_ISSUER,
          audience: ACCESS_TOKEN_AUDIENCE,
          expirationTime: ACCESS_TOKEN_TTL,
          definePayload: ({ user, session }) => ({
            name: user.name,
            email: user.email,
            image: user.image,
            impersonatedBy: (session as { impersonatedBy?: string | null }).impersonatedBy ?? null,
          }),
        },
      }),
      admin({
        defaultRole: USER_ROLE,
        adminRoles: [ADMIN_ROLE],
      }),
    ],
    pages: {
      signIn: "/",
    },
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;

export type AuthSession = Awaited<ReturnType<AuthInstance["api"]["getSession"]>>;
