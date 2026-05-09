import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db as defaultDb, schema, type Database } from "../server/lib/db";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function createAuth(db: Database = defaultDb) {
  const githubClientId = requireEnv("GITHUB_CLIENT_ID");
  const githubClientSecret = requireEnv("GITHUB_CLIENT_SECRET");
  const googleClientId = requireEnv("GOOGLE_CLIENT_ID");
  const googleClientSecret = requireEnv("GOOGLE_CLIENT_SECRET");

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        ...schema,
      },
    }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    emailAndPassword: {
      enabled: process.env.NODE_ENV === "development",
    },
    socialProviders: {
      github: {
        clientId: githubClientId,
        clientSecret: githubClientSecret,
      },
      google: {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
      },
    },
    pages: {
      signIn: "/",
    },
  });
}

type AuthInstance = ReturnType<typeof createAuth>;

export type AuthSession = Awaited<ReturnType<AuthInstance["api"]["getSession"]>>;
