import { cache } from "react";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { headers } from "next/headers";
import { db, schema } from "@opendum/shared/db";

const githubClientId = process.env.GITHUB_CLIENT_ID;
const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!githubClientId || !githubClientSecret) {
  throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required");
}

if (!googleClientId || !googleClientSecret) {
  throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required");
}

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
    github: {
      clientId: githubClientId,
      clientSecret: githubClientSecret,
    },
    google: {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
    },
  },
  plugins: [nextCookies()],
  pages: {
    signIn: "/",
  },
});

/**
 * Get the current session in server components and server actions.
 * Replaces the previous `auth()` pattern from NextAuth.
 * Wrapped with React.cache() to deduplicate calls within a single RSC render pass.
 */
export const getSession = cache(async () => {
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  return session;
});

/**
 * Sign in with a social provider from a server action.
 * Returns a redirect URL for the OAuth flow.
 */
export async function signInSocial(
  provider: "github" | "google",
  redirectTo: string,
) {
  const response = await auth.api.signInSocial({
    body: {
      provider,
      callbackURL: redirectTo,
    },
    headers: await headers(),
  });
  return response;
}
