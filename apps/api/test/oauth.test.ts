import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { decodeJwt } from "jose";
import type { AuthResult } from "@opendum/auth/types";
import { setIdentitySource, verifyOpendumToken } from "@opendum/api/mcp/auth";
import type { McpContext } from "@opendum/api/mcp/types";
import { createAuth } from "@opendum/api/web/auth";
import { IdentityService } from "@opendum/api/web/identity";
import { fullSchema, type Database } from "@opendum/database/client";
import { oauthClient } from "@opendum/database/schema/oauth";

const ISSUER = "http://localhost:4001";
const API = "http://localhost:4001/api/auth";
const RESOURCE = "http://localhost:4001/mcp";
const WEB = "http://localhost:3000";
const SCOPE = "openid profile offline_access opendum:mcp";

process.env.NODE_ENV = "development";
process.env.BETTER_AUTH_SECRET ??= "oauth-integration-secret-0123456789abcdef";
process.env.BETTER_AUTH_URL = API;
process.env.WEB = WEB;
process.env.MAINTAINERS ??= "[]";
process.env.GITHUB_CLIENT_ID ??= "github-test-id";
process.env.GITHUB_CLIENT_SECRET ??= "github-test-secret";
process.env.GOOGLE_CLIENT_ID ??= "google-test-id";
process.env.GOOGLE_CLIENT_SECRET ??= "google-test-secret";

await mock.module("@opendum/api/web/services/points", () => ({
  ensureBalance: () => Effect.succeed(null),
}));

const rejectedKey: AuthResult = {
  valid: false,
  userId: "",
  apiKeyId: "",
  modelAccessMode: "all",
  modelAccessList: [],
  accountAccessMode: "all",
  accountAccessList: [],
  roamingEnabled: false,
  rateLimitRules: [],
  error: "invalid key",
};

const validKey: AuthResult = {
  ...rejectedKey,
  valid: true,
  userId: "key-user",
  apiKeyId: "key-1",
  error: "",
};

let client: PGlite;
let auth: ReturnType<typeof createAuth>;
let testDb: Database;

describe("oauth integration", () => {
  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    const { drizzle } = await import("drizzle-orm/pglite");
    testDb = drizzle(client, { schema: fullSchema }) as unknown as Database;
    auth = createAuth(testDb, { baseURL: API });
    setIdentitySource(async () => new IdentityService(auth));
    process.env.NODE_ENV = "test";
  });

  afterAll(async () => {
    setIdentitySource(null);
    await client?.close();
  });

  it("serves the protected resource metadata document", async () => {
    const response = await auth.handler(new Request(`${ISSUER}/.well-known/oauth-protected-resource/mcp`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.resource).toBe(RESOURCE);
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.scopes_supported).toEqual(["opendum:mcp"]);
  });

  it("serves the authorization server metadata document", async () => {
    const response = await auth.handler(new Request(`${ISSUER}/.well-known/oauth-authorization-server`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(ISSUER);
    expect(body.authorization_endpoint).toBe(`${API}/oauth2/authorize`);
    expect(body.token_endpoint).toBe(`${API}/oauth2/token`);
    const scopes = (body.scopes_supported ?? []) as string[];
    expect(scopes).toContain("opendum:mcp");
    expect(scopes).toContain("offline_access");
  });

  it("redirects unauthenticated authorization requests to the bridge page", async () => {
    const challenge = pkce();
    const authorization = await authorize(
      baseParams("opencode", "http://127.0.0.1:19876/mcp/oauth/callback", challenge.challenge, "state-bridge")
    );
    expect(authorization.redirect).toBe(true);
    const login = new URL(authorization.url);
    expect(login.origin).toBe(WEB);
    expect(login.pathname).toBe("/oauth-bridge");
    const params = login.searchParams;
    expect(params.get("client_id")).toBe("opencode");
    expect(params.get("state")).toBe("state-bridge");
    expect(params.get("sig")).toBeTruthy();
    expect(Number(params.get("exp"))).toBeGreaterThan(Date.now() / 1000);
  });

  it("issues and rotates MCP tokens for a signed-in user", async () => {
    const { cookie } = await signUp();
    const challenge = pkce();
    const authorization = await authorize(
      baseParams("opencode", "http://127.0.0.1:19876/mcp/oauth/callback", challenge.challenge, "state-flow"),
      cookie
    );
    expect(authorization.redirect).toBe(true);
    const issued = new URL(authorization.url);
    expect(issued.origin).toBe("http://127.0.0.1:19876");
    expect(issued.pathname).toBe("/mcp/oauth/callback");
    const code = issued.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(issued.searchParams.get("state")).toBe("state-flow");
    expect(issued.searchParams.get("iss")).toBe(ISSUER);

    const tokens = await tokenRequest({
      grant_type: "authorization_code",
      code: code as string,
      client_id: "opencode",
      redirect_uri: "http://127.0.0.1:19876/mcp/oauth/callback",
      code_verifier: challenge.verifier,
      resource: RESOURCE,
    });
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.refresh_token).toBeTruthy();

    const claims = decodeJwt(tokens.access_token);
    expect(claims.iss).toBe(ISSUER);
    expect([claims.aud].flat().join(" ")).toContain(RESOURCE);
    expect(claims.azp).toBe("opencode");
    expect(claims.client_id).toBe("opencode");
    expect(String(claims.scope)).toContain("opendum:mcp");
    expect(String(claims.scope)).toContain("offline_access");

    const authInfo = await verifyOpendumToken(fallbackContext(rejectedKey), tokens.access_token);
    expect(authInfo.clientId).toBe("opencode");
    expect(authInfo.scopes).toContain("opendum:mcp");
    expect((authInfo.extra as { userId: string }).userId).toBe(String(claims.sub));

    const first = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: "opencode",
      resource: RESOURCE,
    });
    expect(first.access_token).toBeTruthy();
    expect(first.refresh_token).toBeTruthy();
    expect(first.refresh_token).not.toBe(tokens.refresh_token);

    const second = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: "opencode",
      resource: RESOURCE,
    });
    expect(second.access_token).toBeTruthy();
    expect(decodeJwt(second.access_token).sub).toBe(claims.sub);
  });

  it("routes consented clients through the consent page", async () => {
    await testDb.insert(oauthClient).values({
      clientId: "consent-app",
      redirectUris: ["http://127.0.0.1:3000/callback"],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      applicationType: "native",
      skipConsent: false,
      name: "Consent App",
      metadata: {},
    });
    const { cookie } = await signUp();
    const challenge = pkce();
    const first = await authorize(
      baseParams("consent-app", "http://127.0.0.1:3000/callback", challenge.challenge, "state-consent"),
      cookie
    );
    expect(first.redirect).toBe(true);
    const prompt = new URL(first.url);
    expect(prompt.origin).toBe(WEB);
    expect(prompt.pathname).toBe("/oauth-consent");

    const consent = await auth.handler(
      new Request(`${API}/oauth2/consent`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", origin: WEB, cookie },
        body: JSON.stringify({ accept: true, oauth_query: prompt.search.substring(1) }),
      })
    );
    expect(consent.status).toBe(200);
    const decision = (await consent.json()) as { redirect: boolean; url: string };
    expect(decision.redirect).toBe(true);
    const issued = new URL(decision.url);
    expect(issued.origin).toBe("http://127.0.0.1:3000");
    expect(issued.pathname).toBe("/callback");
    expect(issued.searchParams.get("code")).toBeTruthy();
    expect(issued.searchParams.get("state")).toBe("state-consent");

    const tokens = await tokenRequest({
      grant_type: "authorization_code",
      code: issued.searchParams.get("code") as string,
      client_id: "consent-app",
      redirect_uri: "http://127.0.0.1:3000/callback",
      code_verifier: challenge.verifier,
      resource: RESOURCE,
    });
    expect(decodeJwt(tokens.access_token).azp).toBe("consent-app");

    const saved = await authorize(
      baseParams("consent-app", "http://127.0.0.1:3000/callback", challenge.challenge, "state-again"),
      cookie
    );
    const issuedAgain = new URL(saved.url);
    expect(issuedAgain.origin).toBe("http://127.0.0.1:3000");
    expect(issuedAgain.pathname).toBe("/callback");
    expect(issuedAgain.searchParams.get("code")).not.toBe(issued.searchParams.get("code"));
  });

  it("rejects non-MCP tokens and falls back to API keys", async () => {
    const { cookie } = await signUp();
    const webToken = await auth.api.getToken({ headers: { cookie } });
    expect(webToken?.token).toBeTruthy();

    await expect(verifyOpendumToken(fallbackContext(rejectedKey), webToken?.token as string)).rejects.toThrow();
    await expect(verifyOpendumToken(fallbackContext(rejectedKey), "not-a-token")).rejects.toThrow();

    const authInfo = await verifyOpendumToken(fallbackContext(validKey), "opendum-key");
    expect(authInfo.clientId).toBe("key-1");
    expect(authInfo.scopes).toEqual(["opendum:mcp"]);
    expect((authInfo.extra as { userId: string }).userId).toBe("key-user");
  });

  it("blocks non-HTTPS and private hosts in the CIMD metadata transport", async () => {
    const { fetchClientMetadataResource } = await import("@better-auth/cimd/node");
    await expect(fetchClientMetadataResource("http://opendum.example/client.json")).rejects.toThrow();
    await expect(fetchClientMetadataResource("https://localhost/client.json")).rejects.toThrow();
  });
});

async function applyMigrations(client: PGlite): Promise<void> {
  const dir = join(import.meta.dir, "../../../packages/database/drizzle");
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const content = await readFile(join(dir, file), "utf8");
    for (const statement of content.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (!trimmed || trimmed.startsWith("CREATE EXTENSION")) continue;
      await client.exec(trimmed);
    }
  }
}

async function signUp(): Promise<{ email: string; cookie: string }> {
  const email = `${randomUUID()}@example.com`;
  const response = await auth.handler(
    new Request(`${API}/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password-123", name: "OAuth User" }),
    })
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toBeTruthy();
  return { email, cookie: cookie as string };
}

async function authorize(query: URLSearchParams, cookie?: string): Promise<{ redirect: boolean; url: string }> {
  const response = await auth.handler(
    new Request(`${API}/oauth2/authorize?${query.toString()}`, {
      headers: { accept: "application/json", ...(cookie ? { cookie } : {}) },
    })
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { redirect: boolean; url: string };
}

async function tokenRequest(body: Record<string, string>): Promise<Record<string, string>> {
  const response = await auth.handler(
    new Request(`${API}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(body).toString(),
    })
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, string>;
}

function baseParams(client: string, redirect: string, challenge: string, state: string): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: client,
    redirect_uri: redirect,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function fallbackContext(result: AuthResult): McpContext {
  return { auth: { validateKey: () => Effect.succeed(result) } } as unknown as McpContext;
}
