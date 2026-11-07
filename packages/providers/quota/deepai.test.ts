import { describe, expect, it } from "bun:test";
import { Effect } from "effect";

import { deepaiQuota } from "@opendum/providers/quota/fetchers/deepai";
import type { QuotaAccount, QuotaContext } from "@opendum/providers/quota/types";

const THEOS = {
  enabled: true,
  balance: "49.73288",
  granted: "50.00000",
  refresh_at: "2026-11-08T03:37:55+00:00",
  lane_version: 4,
};

const account: QuotaAccount = {
  id: "acc-1",
  userId: "user-1",
  provider: "deepai",
  accessToken: "key-1",
};

function context(body: unknown, captured: { url?: string; headers?: Headers } = {}): QuotaContext {
  return {
    fetch: async (url, init) => {
      captured.url = url;
      captured.headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
    journal: null,
    decrypt: (value) => value,
    getCredentials: async () => "key-1",
  };
}

describe("deepai quota", () => {
  it("reads the Theos balance with the api-key header", async () => {
    const captured: { url?: string; headers?: Headers } = {};
    const result = await Effect.runPromise(deepaiQuota(context(THEOS, captured), account, true));

    expect(captured.url).toBe("https://api.deepai.org/deepai_code/theos");
    expect(captured.headers?.get("api-key")).toBe("key-1");
    expect(captured.headers?.get("X-DeepAI-Code-Theos")).toBe("4");
    expect(captured.headers?.get("X-DeepAI-Code-Instance")).toMatch(/^[0-9a-f]{32}$/);
    expect(captured.headers?.get("X-DeepAI-Code-Machine")).toMatch(/^[0-9a-f]{64}$/);
    expect(result.status).toBe("success");
    expect(result.groups.map((group) => group.name)).toEqual(["theos-balance", "lane"]);
    const [balance] = result.groups;
    expect(balance?.remainingFraction).toBeCloseTo(0.9947, 3);
    expect(balance?.remainingLabel).toBe("49.73 / 50 Theos");
    expect(balance?.resetTimeIso).toBe("2026-11-08T03:37:55.000Z");
    expect(result.groups[1]?.remainingLabel).toBe("v4");
  });

  it("drops the balance group when the allowance is disabled", async () => {
    const result = await Effect.runPromise(
      deepaiQuota(context({ enabled: false, lane_version: 4 }), account, true)
    );
    expect(result.status).toBe("error");
    expect(result.groups).toEqual([]);
  });

  it("marks an expired key instead of throwing", async () => {
    const expired: QuotaContext = {
      ...context({}),
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: "auth_required" } }), { status: 401 }),
    };
    const result = await Effect.runPromise(deepaiQuota(expired, account, true));
    expect(result.status).toBe("expired");
    expect(result.groups).toEqual([]);
  });

  it("returns an error when the payload carries no balance", async () => {
    const result = await Effect.runPromise(deepaiQuota(context({ enabled: true }), account, true));
    expect(result.status).toBe("error");
  });
});
