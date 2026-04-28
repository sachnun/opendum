import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth, type GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { db, schema } from "../server/lib/db";

const githubClientId = process.env.GITHUB_CLIENT_ID;
const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const useOAuthEmulator = process.env.NODE_ENV === "development" || process.env.AUTH_OAUTH_EMULATOR === "1";
const githubEmulatorUrl = process.env.GITHUB_EMULATOR_URL || "http://localhost:4001";
const googleEmulatorUrl = process.env.GOOGLE_EMULATOR_URL || "http://localhost:4002";

if (!useOAuthEmulator && (!githubClientId || !githubClientSecret)) {
  throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required");
}

if (!useOAuthEmulator && (!googleClientId || !googleClientSecret)) {
  throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required");
}

const genericOAuthConfig: GenericOAuthConfig[] = useOAuthEmulator
  ? [
      {
        providerId: "github-emulator",
        clientId: githubClientId || "opendum-github-dev",
        clientSecret: githubClientSecret || "opendum-github-secret",
        authorizationUrl: `${githubEmulatorUrl}/login/oauth/authorize`,
        tokenUrl: `${githubEmulatorUrl}/login/oauth/access_token`,
        scopes: ["read:user", "user:email"],
        async getUserInfo(tokens) {
          const [profileResponse, emailsResponse] = await Promise.all([
            fetch(`${githubEmulatorUrl}/user`, {
              headers: {
                Authorization: `Bearer ${tokens.accessToken}`,
                "User-Agent": "opendum-dashboard",
              },
            }),
            fetch(`${githubEmulatorUrl}/user/emails`, {
              headers: {
                Authorization: `Bearer ${tokens.accessToken}`,
                "User-Agent": "opendum-dashboard",
              },
            }),
          ]);

          if (!profileResponse.ok) {
            return null;
          }

          const profile = await profileResponse.json();
          const emails = emailsResponse.ok ? await emailsResponse.json() : [];
          const primaryEmail = Array.isArray(emails)
            ? emails.find((email) => email.primary)?.email ?? emails[0]?.email
            : null;
          const email = profile.email ?? primaryEmail;

          if (!profile.id || !email) {
            return null;
          }

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
        clientId: googleClientId || "opendum-google-dev.apps.googleusercontent.com",
        clientSecret: googleClientSecret || "opendum-google-secret",
        discoveryUrl: `${googleEmulatorUrl}/.well-known/openid-configuration`,
        scopes: ["openid", "email", "profile"],
        pkce: true,
      },
    ]
  : [];

export const auth = betterAuth({
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
    github: !useOAuthEmulator
      ? {
          clientId: githubClientId,
          clientSecret: githubClientSecret,
        }
      : undefined,
    google: !useOAuthEmulator
      ? {
          clientId: googleClientId,
          clientSecret: googleClientSecret,
        }
      : undefined,
  },
  plugins: genericOAuthConfig.length > 0 ? [genericOAuth({ config: genericOAuthConfig })] : [],
  pages: {
    signIn: "/",
  },
});

export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;
