import { describe, expect, it } from "bun:test";
import { Effect } from "effect";

import { zroQuota } from "@opendum/providers/quota/fetchers/zro";
import type { QuotaAccount, QuotaContext } from "@opendum/providers/quota/types";

const STATUS = {
  key: { id: "key-1", alias: "me" },
  billing: {
    status: "setup_required",
    currency: "USD",
    plan: null,
    usagePacks: { total: 0, used: 0, remaining: 0 },
    totalRemaining: 0,
    free: { remainingPercent: 42, resetsAt: "2026-11-07T00:00:00.000Z" },
  },
  activity30d: { requests: 392, modelRequests: 392, toolCalls: 0, totalTokens: 638909 },
};

const account: QuotaAccount = {
  id: "acc-1",
  userId: "user-1",
  provider: "zro",
  accessToken: "sk-test",
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
    getCredentials: async () => "sk-test",
  };
}

describe("zro quota", () => {
  it("reports the free daily allowance with its reset window", async () => {
    const captured: { url?: string; headers?: Headers } = {};
    const result = await Effect.runPromise(zroQuota(context(STATUS, captured), account, true));

    expect(captured.url).toBe("https://zro.moonmath.ai/api/cli/status");
    expect(captured.headers?.get("Authorization")).toBe("Bearer sk-test");
    expect(result.status).toBe("success");
    expect(result.groups.map((group) => group.name)).toEqual(["free-daily"]);
    const [group] = result.groups;
    expect(group?.remainingFraction).toBe(0.42);
    expect(group?.remainingRequests).toBe(42);
    expect(group?.resetTimeIso).toBe("2026-11-07T00:00:00.000Z");
  });

  it("adds usage pack and plan groups when present", async () => {
    const paid = {
      billing: {
        plan: "pro",
        usagePacks: { total: 10, used: 4, remaining: 6 },
        free: { remainingPercent: 100, resetsAt: "2026-11-07T00:00:00.000Z" },
      },
    };
    const result = await Effect.runPromise(zroQuota(context(paid), account, true));
    const byName = new Map(result.groups.map((group) => [group.name, group]));
    expect(byName.get("free-daily")?.remainingFraction).toBe(1);
    expect(byName.get("usage-packs")?.remainingLabel).toBe("$6 remaining");
    expect(byName.get("plan")?.remainingLabel).toBe("pro");
  });

  it("marks an expired key instead of throwing", async () => {
    const expired: QuotaContext = {
      ...context({}),
      fetch: async () => new Response(JSON.stringify({ error: "Invalid or expired API key." }), { status: 401 }),
    };
    const result = await Effect.runPromise(zroQuota(expired, account, true));
    expect(result.status).toBe("expired");
    expect(result.groups).toEqual([]);
  });

  it("returns an error when the payload carries no usage data", async () => {
    const result = await Effect.runPromise(zroQuota(context({ billing: {} }), account, true));
    expect(result.status).toBe("error");
  });
});
