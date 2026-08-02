import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db as defaultDb, schema, type Database } from "./db/index.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function createAuth(db: Database = defaultDb) {
  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        ...schema,
      },
    }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    trustedOrigins: parseTrustedOrigins(),
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"],
      },
    },
    emailAndPassword: {
      enabled: process.env.NODE_ENV === "development",
    },
    socialProviders: {
      ...(githubClientId && githubClientSecret
        ? { github: { clientId: githubClientId, clientSecret: githubClientSecret } }
        : {}),
      ...(googleClientId && googleClientSecret
        ? { google: { clientId: googleClientId, clientSecret: googleClientSecret } }
        : {}),
    },
    pages: {
      signIn: "/",
    },
  });
}

function parseTrustedOrigins(): string[] | undefined {
  const raw = process.env.TRUSTED_ORIGINS;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : undefined;
  } catch {
    return raw.split(",").map((v) => v.trim()).filter(Boolean);
  }
}

type AuthInstance = ReturnType<typeof createAuth>;

export type AuthSession = Awaited<ReturnType<AuthInstance["api"]["getSession"]>>;
