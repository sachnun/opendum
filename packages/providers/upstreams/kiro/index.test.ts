import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { REFRESH_ENDPOINT as KIRO_REFRESH_ENDPOINT } from "@opendum/providers/auth/kiro/constants";
import type { UpstreamTransport } from "@opendum/providers/core/http";
import type { ProviderAccount } from "@opendum/providers/types";
import { KiroProvider } from "@opendum/providers/upstreams/kiro/index";

const account = { id: "acc-1" } as unknown as ProviderAccount;
const USAGE_ENDPOINT = "https://q.us-east-1.amazonaws.com/";

type Route = { status?: number; body: string };
type Captured = { url: string; init?: RequestInit };

function provider(routes: { refresh: Route; usage?: Route }, captured?: Captured[]): KiroProvider {
  const direct = async (url: string, init?: RequestInit): Promise<Response> => {
    captured?.push({ url, init });
    const route = url === KIRO_REFRESH_ENDPOINT ? routes.refresh : routes.usage;
    return new Response(route?.body ?? "{}", { status: route?.status ?? 200 });
  };
  const transport: UpstreamTransport = { direct, egress: null, egressReady: () => false };
  const registry = { upstream: (name: string) => name } as unknown as Registry;
  return new KiroProvider({ registry, transport });
}

async function refresh(kiro: KiroProvider, refreshToken = "rt-1") {
  return Effect.runPromise(
    kiro.refreshCredentials(refreshToken, account).pipe(
      Effect.map((credentials) => ({ ok: true as const, credentials })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error }))
    )
  );
}

describe("KiroProvider.refreshCredentials", () => {
  it("refreshes the token and reads the subscription tier", async () => {
    const captured: Captured[] = [];
    const fake = provider(
      {
        refresh: { body: JSON.stringify({ accessToken: "  at-1  ", refreshToken: "rt-2", expiresIn: 7200 }) },
        usage: { body: JSON.stringify({ subscriptionInfo: { type: "Q_DEVELOPER_STANDALONE_POWER" } }) },
      },
      captured
    );
    const before = Date.now();
    const result = await refresh(fake, " rt-1 ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credentials.accessToken).toBe("at-1");
      expect(result.credentials.refreshToken).toBe("rt-2");
      expect(result.credentials.tier).toBe("power");
      expect(result.credentials.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7200 * 1000);
    }
    expect(captured[0]?.url).toBe(KIRO_REFRESH_ENDPOINT);
    expect(JSON.parse(String(captured[0]?.init?.body))).toEqual({ refreshToken: "rt-1" });
    expect(captured[1]?.url).toBe(USAGE_ENDPOINT);
  });

  it("defaults to a one hour expiry and keeps the stored refresh token", async () => {
    const before = Date.now();
    const result = await refresh(
      provider({
        refresh: { body: JSON.stringify({ accessToken: "at-1" }) },
        usage: { body: JSON.stringify({ subscriptionInfo: { type: "Q_DEVELOPER_STANDALONE_PRO" } }) },
      }),
      "rt-1"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credentials.refreshToken).toBe("rt-1");
      expect(result.credentials.tier).toBe("pro");
      expect(result.credentials.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
    }
  });

  it("keeps the credentials when the usage lookup fails", async () => {
    const result = await refresh(
      provider({
        refresh: { body: JSON.stringify({ accessToken: "at-1" }) },
        usage: { status: 500, body: "nope" },
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credentials.tier).toBe("");
  });

  it("fails with the provider label on non-2xx refresh responses", async () => {
    const result = await refresh(provider({ refresh: { status: 401, body: "nope" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.provider).toBe("kiro");
      expect(result.error.message).toBe("kiro token refresh failed: 401 nope");
    }
  });

  it("rejects empty access tokens", async () => {
    const result = await refresh(provider({ refresh: { body: JSON.stringify({ accessToken: "  " }) } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("kiro token refresh returned empty access token");
  });
});
