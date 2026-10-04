import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db as defaultDb, schema, type Database } from "@opendum/database";
import { ensureUserPointBalance } from "../server/services/points";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function createAuth(db: Database = defaultDb) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        ...schema,
      },
    }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"],
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (createdUser) => {
            try {
              await ensureUserPointBalance(createdUser.id);
            } catch (error) {
              console.error("Failed to initialize point balance:", error);
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
    plugins: [],
    pages: {
      signIn: "/",
    },
  });
}

type AuthInstance = ReturnType<typeof createAuth>;

export type AuthSession = Awaited<ReturnType<AuthInstance["api"]["getSession"]>>;
