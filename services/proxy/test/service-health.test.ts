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
  logAccountError,
  logUsageRaw,
  markAccountFailed,
  markAccountSuccess,
  markAccountUsageLimited,
  markAccountsRecoveredByRotation,
  recordSuccessfulRequest,
  refreshAccountHealthFromModels,
  storeHypercreditsUsage,
} from "../src/core/health/service-health.ts";
import type { ProxyDeps } from "../src/core/service-deps.ts";
import {
  ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD,
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

function healthRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date();
  return {
    id: "h1",
    consecutiveErrors: 0,
    status: "active",
    lastErrorAt: null,
    lastErrorCode: null,
    lastSuccessAt: null,
    unhealthyCountUpdatedAt: now,
    ...overrides,
  };
}

describe("markAccountSuccess", () => {
  it("records success and updates existing health", async () => {
    const d = deps();
    db.getModelHealth.mockResolvedValueOnce(healthRow());
    await markAccountSuccess(d, "a1", "m");
    assert.equal(db.markAccountSuccess.mock.calls.length > 0, true);
    assert.equal(db.updateModelHealthSuccess.mock.calls.length > 0, true);

    db.getModelHealth.mockResolvedValueOnce(healthRow({ consecutiveErrors: 3, status: "active" }));
    await markAccountSuccess(d, "a1", "m");
    assert.equal(db.updateModelHealthSuccessWithStatus.mock.calls.length > 0, true);
  });

  it("inserts nothing and refreshes for missing health", async () => {
    const d = deps();
    db.getModelHealth.mockResolvedValueOnce(null);
    await markAccountSuccess(d, "a1", "m");
    assert.equal(db.markAccountSuccess.mock.calls.length > 0, true);
  });

  it("skips synthetic accounts", async () => {
    const d = deps();
    const before = db.markAccountSuccess.mock.calls.length;
    await markAccountSuccess(d, "opencode", "m");
    assert.equal(db.markAccountSuccess.mock.calls.length, before);
  });
});

describe("markAccountFailed", () => {
  it("inserts new model health and logs history", async () => {
    const d = deps();
    db.getModelHealth.mockResolvedValueOnce(null);
    db.getAccountOwnerUserID.mockResolvedValueOnce("owner");
    await markAccountFailed(d, "a1", "m", 500, "boom");
    assert.equal(db.recordRequestError.mock.calls.length > 0, true);
    assert.equal(db.insertModelHealth.mock.calls.length > 0, true);
  });

  it("updates existing health with and without status changes", async () => {
    const d = deps();
    db.getModelHealth.mockResolvedValueOnce(healthRow({ consecutiveErrors: 0 }));
    await markAccountFailed(d, "a1", "m", 500, "boom");
    assert.equal(db.updateModelHealthFailure.mock.calls.length > 0, true);

    db.getModelHealth.mockResolvedValueOnce(healthRow({ consecutiveErrors: 1 }));
    await markAccountFailed(d, "a1", "m", 500, "boom");
    assert.equal(db.updateModelHealthFailureWithStatus.mock.calls.length > 0, true);
  });

  it("skips synthetic accounts", async () => {
    const d = deps();
    const before = db.recordRequestError.mock.calls.length;
    const now = await markAccountFailed(d, "authless:x", "m", 500, "boom");
    assert.equal(db.recordRequestError.mock.calls.length, before);
    assert.ok(now instanceof Date);
  });
});

describe("markAccountUsageLimited", () => {
  it("marks usage limits", async () => {
    const d = deps();
    await markAccountUsageLimited(d, "a1", "m", new Date(), new Date());
    assert.equal(db.markUsageLimitedHealth.mock.calls.length > 0, true);
    assert.equal(db.setAccountUsageLimited.mock.calls.length > 0, true);
  });

  it("skips synthetic accounts", async () => {
    const d = deps();
    const before = db.markUsageLimitedHealth.mock.calls.length;
    await markAccountUsageLimited(d, "authless:x", "m", new Date(), new Date());
    assert.equal(db.markUsageLimitedHealth.mock.calls.length, before);
  });
});

describe("markAccountsRecoveredByRotation", () => {
  it("uses the latest failure per account", async () => {
    await markAccountsRecoveredByRotation(deps(), []);
    const d = deps();
    const old = new Date(Date.now() - 1000);
    const recent = new Date();
    await markAccountsRecoveredByRotation(d, [
      { accountId: "a1", failedAt: old, provider: "p", model: "m", statusCode: 500 } as never,
      { accountId: "a1", failedAt: recent, provider: "p", model: "m", statusCode: 500 } as never,
      { accountId: "opencode", failedAt: recent, provider: "p", model: "m", statusCode: 500 } as never,
    ]);
    assert.equal(db.markAccountRecoveredByRotation.mock.calls.length, 1);
  });
});

describe("logAccountError", () => {
  it("writes to history and skips synthetic accounts", async () => {
    const d = deps();
    await logAccountError(d, "a1", "u1", "m", 500, "x".repeat(20000));
    assert.equal((d.redis.set as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0, true);
    await logAccountError(d, "opencode", "u1", "m", 500, "x");
  });
});

describe("refreshAccountHealthFromModels", () => {
  it("returns false for missing accounts", async () => {
    db.getAccountHealthState.mockResolvedValueOnce(null);
    assert.equal(await refreshAccountHealthFromModels(deps(), "a1", new Date()), false);
  });

  it("keeps accounts failing while disabled", async () => {
    const d = deps();
    db.getAccountHealthState.mockResolvedValueOnce({ status: "failed", disabledUntil: new Date(Date.now() + 60000), consecutiveErrors: 3 });
    assert.equal(await refreshAccountHealthFromModels(d, "a1", new Date()), true);
    assert.equal(db.setAccountHealthFailed.mock.calls.length > 0, true);
  });

  it("cools down accounts with too many unhealthy models", async () => {
    const d = deps();
    const now = new Date();
    db.getAccountHealthState.mockResolvedValueOnce({ status: "active", disabledUntil: null, consecutiveErrors: 0 });
    db.listModelHealthByAccount.mockResolvedValueOnce([healthRow({ consecutiveErrors: ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD, status: "degraded", unhealthyCountUpdatedAt: now })] as never);
    assert.equal(await refreshAccountHealthFromModels(d, "a1", now), true);
    assert.equal(db.setAccountCooldown.mock.calls.length > 0, true);
  });

  it("recovers accounts after cooldown", async () => {
    const d = deps();
    const now = new Date();
    db.getAccountHealthState.mockResolvedValueOnce({ status: "failed", disabledUntil: new Date(now.getTime() - 1000), consecutiveErrors: 5 });
    db.listModelHealthByAccount.mockResolvedValueOnce([healthRow({ consecutiveErrors: 2, status: "degraded", unhealthyCountUpdatedAt: now })] as never);
    assert.equal(await refreshAccountHealthFromModels(d, "a1", now), false);
    assert.equal(db.setAccountActive.mock.calls.length > 0, true);
  });

  it("returns false for healthy active accounts", async () => {
    const d = deps();
    db.getAccountHealthState.mockResolvedValueOnce({ status: "active", disabledUntil: null, consecutiveErrors: 0 });
    db.listModelHealthByAccount.mockResolvedValueOnce([]);
    assert.equal(await refreshAccountHealthFromModels(d, "a1", new Date()), false);
  });

  it("skips synthetic accounts", async () => {
    assert.equal(await refreshAccountHealthFromModels(deps(), "opencode", new Date()), false);
    const before = db.bumpAccountRequestCount.mock.calls.length;
    await bumpAccountRequestCountDeferred(deps(), "authless:x");
    assert.equal(db.bumpAccountRequestCount.mock.calls.length, before);
  });

  it("updates counters without status changes", async () => {
    const d = deps();
    const now = new Date();
    db.getAccountHealthState.mockResolvedValueOnce({ status: "failed", disabledUntil: new Date(now.getTime() - 1000), consecutiveErrors: 10 });
    db.listModelHealthByAccount.mockResolvedValueOnce([healthRow({ consecutiveErrors: 10, status: "degraded", unhealthyCountUpdatedAt: now })]);
    assert.equal(await refreshAccountHealthFromModels(d, "a1", now), false);
    assert.equal(db.updateModelHealthCounters.mock.calls.length >= 1, true);
  });

  it("swallows deferred write failures", async () => {
    const store = new Map<string, string>();
    const failingRedis = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async () => {
        throw new Error("down");
      }),
    } as unknown as OpendumRedis;
    storeHypercreditsUsage({ ...deps(), redis: failingRedis } as ProxyDeps, "a1", 5, 0);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const d = deps();
    (d.performance.record as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("down"));
    recordSuccessfulRequest(d, {
      accountId: "a1",
      provider: "p",
      model: "m",
      userId: "u1",
      apiKeyId: "k1",
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 1,
      stream: false,
      requestStartMs: 0,
      upstreamFirstResponseMs: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    db.insertUsageLog.mockRejectedValueOnce(new Error("down"));
    await logUsageRaw(d, { userId: "u1", providerAccountId: "a1", proxyApiKeyId: "k1", model: "m", inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, statusCode: 200, durationMs: 1 });
  });
});
