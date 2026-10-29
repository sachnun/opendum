import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { ANTIGRAVITY_TOKEN_ENDPOINT } from "@opendum/providers/auth/antigravity/constants";
import type { UpstreamTransport } from "@opendum/providers/http";
import type { ProviderAccount } from "@opendum/providers/types";
import { AntigravityProvider } from "@opendum/providers/upstreams/antigravity/index";

const account = { id: "acc-1" } as unknown as ProviderAccount;
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";

type Route = { status?: number; body: string };
type Captured = { url: string; init?: RequestInit };

function provider(route: (url: string) => Route | null, captured?: Captured[]): AntigravityProvider {
  const direct = async (url: string, init?: RequestInit): Promise<Response> => {
    captured?.push({ url, init });
    const resolved = route(url) ?? { body: "{}" };
    return new Response(resolved.body, { status: resolved.status ?? 200 });
  };
  const transport: UpstreamTransport = { direct, egress: null, egressReady: () => false };
  const registry = { upstream: (name: string) => name } as unknown as Registry;
  return new AntigravityProvider({ registry, transport });
}

async function refresh(antigravity: AntigravityProvider, refreshToken = "rt-1") {
  return Effect.runPromise(
    antigravity.refreshCredentials(refreshToken, account).pipe(
      Effect.map((credentials) => ({ ok: true as const, credentials })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error }))
    )
  );
}

describe("AntigravityProvider.refreshCredentials", () => {
  it("refreshes the token and composes the account info", async () => {
    const captured: Captured[] = [];
    const fake = provider((url) => {
      if (url === ANTIGRAVITY_TOKEN_ENDPOINT) {
        return { body: JSON.stringify({ access_token: "at-1", refresh_token: "rt-2", expires_in: 1800 }) };
      }
      if (url.endsWith("/v1internal:loadCodeAssist")) {
        return { body: JSON.stringify({ cloudaicompanionProject: "proj-1", currentTier: { id: "Standard-Tier" } }) };
      }
      if (url === USERINFO_ENDPOINT) return { body: JSON.stringify({ email: "user@test" }) };
      return null;
    }, captured);
    const before = Date.now();
    const result = await refresh(fake, " rt-1 ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credentials.accessToken).toBe("at-1");
      expect(result.credentials.refreshToken).toBe("rt-2");
      expect(result.credentials.projectId).toBe("proj-1");
      expect(result.credentials.tier).toBe("standard-tier");
      expect(result.credentials.paidTier).toBe("");
      expect(result.credentials.email).toBe("user@test");
      expect(result.credentials.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 1800 * 1000);
    }
    expect(captured[0]?.url).toBe(ANTIGRAVITY_TOKEN_ENDPOINT);
    const form = new URLSearchParams(String(captured[0]?.init?.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt-1");
    expect(form.get("client_id")).toBeTruthy();
    expect(form.get("client_secret")).toBeTruthy();
  });

  it("falls back to the free tier and a one hour expiry without account info", async () => {
    const before = Date.now();
    const result = await refresh(
      provider((url) =>
        url === ANTIGRAVITY_TOKEN_ENDPOINT ? { body: JSON.stringify({ access_token: "at-1" }) } : null
      )
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credentials.tier).toBe("free-tier");
      expect(result.credentials.projectId).toBe("");
      expect(result.credentials.email).toBe("");
      expect(result.credentials.refreshToken).toBe("rt-1");
      expect(result.credentials.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
    }
  });

  it("fails with the provider label on non-2xx responses", async () => {
    const result = await refresh(provider((url) => (url === ANTIGRAVITY_TOKEN_ENDPOINT ? { status: 400, body: "bad" } : null)));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.provider).toBe("antigravity");
      expect(result.error.message).toBe("antigravity token refresh failed: 400 bad");
    }
  });

  it("rejects empty access tokens", async () => {
    const result = await refresh(provider((url) => (url === ANTIGRAVITY_TOKEN_ENDPOINT ? { body: "{}" } : null)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("antigravity token refresh returned empty access token");
  });
});
