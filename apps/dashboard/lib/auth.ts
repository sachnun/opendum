import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth, type GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { db as defaultDb, schema, type Database } from "@opendum/database";
import { ensureUserPointBalance } from "../server/services/points";

const DEV_GITHUB_CLIENT_ID = "opendum-github-dev";
const DEV_GITHUB_CLIENT_SECRET = "opendum-github-secret";
const DEV_GOOGLE_CLIENT_ID = "opendum-google-dev.apps.googleusercontent.com";
const DEV_GOOGLE_CLIENT_SECRET = "opendum-google-secret";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function useOAuthEmulator(): boolean {
  return process.env.AUTH_OAUTH_EMULATOR === "1";
}

function emulatorProviders(): GenericOAuthConfig[] {
  const githubUrl = process.env.GITHUB_EMULATOR_URL ?? "http://localhost:4001";
  const googleUrl = process.env.GOOGLE_EMULATOR_URL ?? "http://localhost:4002";

  return [
    {
      providerId: "github-emulator",
      clientId: DEV_GITHUB_CLIENT_ID,
      clientSecret: DEV_GITHUB_CLIENT_SECRET,
      authorizationUrl: `${githubUrl}/login/oauth/authorize`,
      tokenUrl: `${githubUrl}/login/oauth/access_token`,
      scopes: ["read:user", "user:email"],
      pkce: false,
      async getUserInfo(tokens) {
        if (!tokens.accessToken) return null;

        const headers = {
          Authorization: `Bearer ${tokens.accessToken}`,
          "User-Agent": "opendum-dashboard",
        };
        const [profileResponse, emailsResponse] = await Promise.all([
          fetch(`${githubUrl}/user`, { headers }),
          fetch(`${githubUrl}/user/emails`, { headers }),
        ]);

        if (!profileResponse.ok) return null;

        const profile = await profileResponse.json();
        const emails = emailsResponse.ok ? await emailsResponse.json() : [];
        const primaryEmail = Array.isArray(emails)
          ? emails.find((email) => email.primary)?.email ?? emails[0]?.email
          : null;
        const email = profile.email ?? primaryEmail;

        if (!profile.id || !email) return null;

        return {
          id: String(profile.id),
          name: profile.name || profile.login || "GitHub Emulator User",
          email,
          emailVerified: true,
          image: profile.avatar_url,
        };
      },
    },
    {
      providerId: "google-emulator",
      clientId: DEV_GOOGLE_CLIENT_ID,
      clientSecret: DEV_GOOGLE_CLIENT_SECRET,
      discoveryUrl: `${googleUrl}/.well-known/openid-configuration`,
      scopes: ["openid", "email", "profile"],
      pkce: true,
    },
  ];
}

export function createAuth(db: Database = defaultDb) {
  const useEmulator = useOAuthEmulator();

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
    socialProviders: useEmulator
      ? {}
      : {
          github: {
            clientId: requireEnv("GITHUB_CLIENT_ID"),
            clientSecret: requireEnv("GITHUB_CLIENT_SECRET"),
          },
          google: {
            clientId: requireEnv("GOOGLE_CLIENT_ID"),
            clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
          },
        },
    plugins: useEmulator ? [genericOAuth({ config: emulatorProviders() })] : [],
    pages: {
      signIn: "/",
    },
  });
}

type AuthInstance = ReturnType<typeof createAuth>;

export type AuthSession = Awaited<ReturnType<AuthInstance["api"]["getSession"]>>;
