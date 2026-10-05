import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import type { AuthService } from "@opendum/auth";
import type { Database } from "@opendum/database";
import type { Registry } from "@opendum/models/runtime";
import type { ProviderRegistry } from "@opendum/providers";
import type { OpendumRedis } from "@opendum/redis";

const db = vi.hoisted(() => {
  const m = () => vi.fn<() => Promise<unknown>>(async () => null);
  return {
    bumpAccountRequestCount: m(),
    getAccountHealthState: m(),
    getAccountOwnerUserID: m(),
    getModelHealth: m(),
    insertModelHealth: m(),
    insertUsageLog: m(),
    listModelHealthByAccount: m(),
    markAccountRecoveredByRotation: m(),
    markAccountSuccess: m(),
    markUsageLimitedHealth: m(),
    recordRequestError: m(),
    setAccountActive: m(),
    setAccountCooldown: m(),
    setAccountHealthFailed: m(),
    setAccountUsageLimited: m(),
    updateModelHealthCounters: m(),
    updateModelHealthFailure: m(),
    updateModelHealthFailureWithStatus: m(),
    updateModelHealthStatus: m(),
    updateModelHealthSuccess: m(),
    updateModelHealthSuccessWithStatus: m(),
  };
});

vi.mock("@opendum/database/queries", () => db);

db.listModelHealthByAccount.mockResolvedValue([]);

import {
  bumpAccountRequestCountDeferred,
  logUsage,
  logUsageRaw,
  recordResponseHandlerFailure,
  recordSuccessfulRequest,
  storeHypercreditsUsage,
} from "../src/core/health/service-health.ts";
import type { ProxyDeps } from "../src/core/service-deps.ts";
import {
  HYPERCREDITS_BALANCE_PREFIX,
} from "../src/core/service-constants.ts";

function fakeRedis(store = new Map<string, string>()): { redis: OpendumRedis; store: Map<string, string> } {
  return {
    store,
    redis: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    } as unknown as OpendumRedis,
  };
}

function deps(): ProxyDeps {
  return {
    database: {} as Database,
    redis: fakeRedis().redis,
    models: { resolveAlias: (model: string) => model } as unknown as Registry,
    auth: { bumpAnalyticsCacheVersionThrottled: vi.fn(async () => undefined) } as unknown as AuthService,
    providers: {} as ProviderRegistry,
    performance: { record: vi.fn(async () => undefined) },
  } as unknown as ProxyDeps;
}

describe("usage logging", () => {
  it("writes usage rows", async () => {
    const d = deps();
    await logUsageRaw(d, {
      userId: "u1",
      providerAccountId: "a1",
      proxyApiKeyId: "k1",
      model: "m",
      inputTokens: 1,
      outputTokens: 2,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      statusCode: 200,
      durationMs: 10,
    });
    assert.equal(db.insertUsageLog.mock.calls.length > 0, true);
    assert.equal((d.auth.bumpAnalyticsCacheVersionThrottled as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0, true);

    await logUsageRaw(d, { userId: "", providerAccountId: "a1", proxyApiKeyId: "k1", model: "m", inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, statusCode: 200, durationMs: 0 });
  });

  it("logs usage via the wrapper", async () => {
    const d = deps();
    await logUsage(
      d,
      { userId: "u1", apiKeyId: "k1" } as never,
      { id: "a1" } as never,
      { model: "m" } as never,
      200,
      5
    );
    assert.equal(db.insertUsageLog.mock.calls.length > 0, true);
  });

  it("bumps account request counts and swallows errors", async () => {
    const d = deps();
    await bumpAccountRequestCountDeferred(d, "a1");
    db.bumpAccountRequestCount.mockRejectedValueOnce(new Error("down"));
    await bumpAccountRequestCountDeferred(d, "a1");
  });

  it("records handler failures", async () => {
    const d = deps();
    db.getModelHealth.mockResolvedValueOnce(null);
    await recordResponseHandlerFailure(
      d,
      { id: "a1" } as never,
      { userId: "u1", apiKeyId: "k1" } as never,
      { model: "m" } as never,
      500,
      "boom",
      Date.now()
    );
    assert.equal(db.insertModelHealth.mock.calls.length > 0, true);
  });
});

describe("hypercredits", () => {
  it("stores and decrements balances", async () => {
    const store = new Map<string, string>();
    const d = { ...deps(), redis: fakeRedis(store).redis } as ProxyDeps;
    storeHypercreditsUsage(d, "a1", 5, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.get(HYPERCREDITS_BALANCE_PREFIX + "a1"), "5");

    storeHypercreditsUsage(d, "a1", null, 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.get(HYPERCREDITS_BALANCE_PREFIX + "a1"), "3");

    storeHypercreditsUsage(d, "", 1, 0);
  });
});

describe("recordSuccessfulRequest", () => {
  it("records success asynchronously", async () => {
    const d = deps();
    db.getModelHealth.mockResolvedValueOnce(null);
    recordSuccessfulRequest(d, {
      accountId: "a1",
      provider: "p",
      model: "m",
      userId: "u1",
      apiKeyId: "k1",
      inputTokens: 1,
      outputTokens: 2,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 10,
      stream: false,
      requestStartMs: 0,
      upstreamFirstResponseMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((d.performance.record as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0, true);
    assert.equal(db.markAccountSuccess.mock.calls.length > 0, true);
  });
});
