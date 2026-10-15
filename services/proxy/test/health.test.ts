import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Database } from "@opendum/database";
import type { OpendumRedis } from "@opendum/core/redis";
import type { Registry } from "@opendum/models/runtime";
import { createDatabaseQueryMocks } from "./database-mock.js";

const db = createDatabaseQueryMocks();
mock.module("@opendum/database/queries", () => db);

const { AccountHealthService, MAX_STORED_ERROR_LEN } = await import("../core/account-health.js");

type HealthServiceOptions = ConstructorParameters<typeof AccountHealthService>[0];

function fakeModels(): Registry {
  return { resolveAlias: (model: string) => model } as unknown as Registry;
}

function fakeRedis(overrides: Partial<Record<string, unknown>> = {}): OpendumRedis {
  return {
    get: async () => null,
    set: async () => "OK",
    zAdd: async () => 1,
    expire: async () => true,
    ...overrides,
  } as unknown as OpendumRedis;
}

function healthService(options: Partial<HealthServiceOptions> = {}): InstanceType<typeof AccountHealthService> {
  return new AccountHealthService({
    database: db as unknown as Database,
    models: fakeModels(),
    redis: fakeRedis(),
    ...options,
  });
}

beforeEach(() => {
  for (const value of Object.values(db)) {
    (value as { mockClear: () => void }).mockClear();
  }
});

describe("AccountHealthService", () => {
  it("inserts a model health row on the first failure", async () => {
    const failedAt = await healthService().markAccountFailed("acc-1", "gpt-4o", 500, "upstream boom");
    expect(failedAt).toBeInstanceOf(Date);
    expect(db.recordRequestError).toHaveBeenCalledTimes(1);
    expect(db.insertModelHealth).toHaveBeenCalledTimes(1);
    const inserted = (db.insertModelHealth.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(inserted.providerAccountId).toBe("acc-1");
    expect(inserted.model).toBe("gpt-4o");
    expect(inserted.consecutiveErrors).toBe(1);
  });

  it("truncates oversized error messages before storing them", async () => {
    db.getAccountOwnerUserID.mockResolvedValueOnce("owner-1" as never);
    const stored: string[] = [];
    const redis = fakeRedis({
      set: async (_key: string, value: string) => {
        stored.push(value);
        return "OK";
      },
    });
    const message = "x".repeat(MAX_STORED_ERROR_LEN + 50);
    await healthService({ redis }).markAccountFailed("acc-1", "gpt-4o", 500, message);
    const entryJson = stored.find((value) => value.includes("errorMessage"));
    expect(entryJson).toBeDefined();
    const entry = JSON.parse(entryJson as string) as { errorMessage: string };
    expect(entry.errorMessage.length).toBe(MAX_STORED_ERROR_LEN);
  });

  it("puts an account into cooldown once unhealthy rows reach the threshold", async () => {
    const now = new Date();
    db.getAccountHealthState.mockResolvedValueOnce({
      status: "active",
      consecutiveErrors: 0,
      disabledUntil: null,
    } as never);
    db.listModelHealthByAccount.mockResolvedValueOnce([
      {
        id: "row-1",
        consecutiveErrors: 10,
        status: "failed",
        unhealthyCountUpdatedAt: now,
        lastErrorAt: now,
        lastSuccessAt: null,
        createdAt: now,
        updatedAt: now,
        lastErrorCode: 500,
      },
    ] as never);

    const coolingDown = await healthService().refreshAccountHealthFromModels("acc-1", now);
    expect(coolingDown).toBe(true);
    expect(db.setAccountCooldown).toHaveBeenCalledTimes(1);
  });

  it("marks accounts active again after failures decay", async () => {
    const now = new Date();
    const staleAt = new Date(now.getTime() - 60 * 60 * 1000);
    db.getAccountHealthState.mockResolvedValueOnce({
      status: "failed",
      consecutiveErrors: 2,
      disabledUntil: staleAt,
    } as never);
    db.listModelHealthByAccount.mockResolvedValueOnce([
      {
        id: "row-1",
        consecutiveErrors: 2,
        status: "failed",
        unhealthyCountUpdatedAt: staleAt,
        lastErrorAt: staleAt,
        lastSuccessAt: null,
        createdAt: staleAt,
        updatedAt: staleAt,
        lastErrorCode: 500,
      },
    ] as never);

    const coolingDown = await healthService().refreshAccountHealthFromModels("acc-1", now);
    expect(coolingDown).toBe(false);
    expect(db.setAccountActive).toHaveBeenCalledTimes(1);
  });

  it("recovers a degraded model row on success", async () => {
    const now = new Date();
    db.getModelHealth.mockResolvedValueOnce({
      id: "row-1",
      consecutiveErrors: 3,
      status: "degraded",
      unhealthyCountUpdatedAt: now,
      lastErrorAt: now,
      lastSuccessAt: null,
      createdAt: now,
      updatedAt: now,
      lastErrorCode: 429,
    } as never);

    await healthService().markAccountSuccess("acc-1", "gpt-4o");
    expect(db.markAccountSuccess).toHaveBeenCalledTimes(1);
    expect(db.updateModelHealthSuccess).toHaveBeenCalledTimes(1);
  });

  it("skips synthetic accounts", async () => {
    const failedAt = await healthService().markAccountFailed("opencode", "gpt-4o", 500, "boom");
    expect(failedAt).toBeInstanceOf(Date);
    await healthService().markAccountSuccess("opencode", "gpt-4o");
    expect(db.recordRequestError).toHaveBeenCalledTimes(0);
    expect(db.markAccountSuccess).toHaveBeenCalledTimes(0);
    expect(await healthService().refreshAccountHealthFromModels("opencode", new Date())).toBe(false);
  });

  it("stores account errors in the redis error history", async () => {
    const stored: string[] = [];
    const redis = fakeRedis({
      set: async (_key: string, value: string) => {
        stored.push(value);
        return "OK";
      },
    });
    await healthService({ redis }).logAccountError("acc-1", "user-1", "gpt-4o", 429, "rate limited");
    expect(stored.some((value) => value.includes("rate limited"))).toBe(true);
  });

  it("bumps request counts in the background", async () => {
    healthService().bumpRequestCount("acc-1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(db.bumpAccountRequestCount).toHaveBeenCalledTimes(1);
  });
});
