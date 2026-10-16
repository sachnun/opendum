import { beforeEach, describe, expect, it } from "bun:test";
import type { OpendumRedis } from "@opendum/core/redis";
import type { Registry } from "@opendum/models/runtime";
import { Health, MAX_ERROR_LEN } from "../core/health.js";
import { fakes, type Fakes } from "./fake-repositories.js";

type HealthServiceOptions = ConstructorParameters<typeof Health>[0];

let repositories: Fakes;

beforeEach(() => {
  repositories = fakes();
});

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

function healthService(options: Partial<HealthServiceOptions> = {}): InstanceType<typeof Health> {
  return new Health({
    accounts: repositories.accounts,
    health: repositories.health,
    models: fakeModels(),
    redis: fakeRedis(),
    ...options,
  });
}

describe("Health", () => {
  it("inserts a model health row on the first failure", async () => {
    const failedAt = await healthService().markAccountFailed("acc-1", "gpt-4o", 500, "upstream boom");
    expect(failedAt).toBeInstanceOf(Date);
    expect(repositories.health.recordRequestError).toHaveBeenCalledTimes(1);
    expect(repositories.health.insertModelHealth).toHaveBeenCalledTimes(1);
    const inserted = (repositories.health.insertModelHealth.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(inserted.providerAccountId).toBe("acc-1");
    expect(inserted.model).toBe("gpt-4o");
    expect(inserted.consecutiveErrors).toBe(1);
  });

  it("truncates oversized error messages before storing them", async () => {
    repositories.accounts.getAccountOwnerUserID.mockResolvedValueOnce("owner-1");
    const stored: string[] = [];
    const redis = fakeRedis({
      set: async (_key: string, value: string) => {
        stored.push(value);
        return "OK";
      },
    });
    const message = "x".repeat(MAX_ERROR_LEN + 50);
    await healthService({ redis }).markAccountFailed("acc-1", "gpt-4o", 500, message);
    const entryJson = stored.find((value) => value.includes("errorMessage"));
    expect(entryJson).toBeDefined();
    const entry = JSON.parse(entryJson as string) as { errorMessage: string };
    expect(entry.errorMessage.length).toBe(MAX_ERROR_LEN);
  });

  it("puts an account into cooldown once unhealthy rows reach the threshold", async () => {
    const now = new Date();
    repositories.health.getAccountHealthState.mockResolvedValueOnce({
      status: "active",
      consecutiveErrors: 0,
      disabledUntil: null,
    } as never);
    repositories.health.listModelHealthByAccount.mockResolvedValueOnce([
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

    const coolingDown = await healthService().refresh("acc-1", now);
    expect(coolingDown).toBe(true);
    expect(repositories.health.setAccountCooldown).toHaveBeenCalledTimes(1);
  });

  it("marks accounts active again after failures decay", async () => {
    const now = new Date();
    const staleAt = new Date(now.getTime() - 60 * 60 * 1000);
    repositories.health.getAccountHealthState.mockResolvedValueOnce({
      status: "failed",
      consecutiveErrors: 2,
      disabledUntil: staleAt,
    } as never);
    repositories.health.listModelHealthByAccount.mockResolvedValueOnce([
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

    const coolingDown = await healthService().refresh("acc-1", now);
    expect(coolingDown).toBe(false);
    expect(repositories.health.setAccountActive).toHaveBeenCalledTimes(1);
  });

  it("recovers a degraded model row on success", async () => {
    const now = new Date();
    repositories.health.getModelHealth.mockResolvedValueOnce({
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
    expect(repositories.health.markAccountSuccess).toHaveBeenCalledTimes(1);
    expect(repositories.health.updateModelHealthSuccess).toHaveBeenCalledTimes(1);
  });

  it("skips synthetic accounts", async () => {
    const failedAt = await healthService().markAccountFailed("opencode", "gpt-4o", 500, "boom");
    expect(failedAt).toBeInstanceOf(Date);
    await healthService().markAccountSuccess("opencode", "gpt-4o");
    expect(repositories.health.recordRequestError).toHaveBeenCalledTimes(0);
    expect(repositories.health.markAccountSuccess).toHaveBeenCalledTimes(0);
    expect(await healthService().refresh("opencode", new Date())).toBe(false);
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
    expect(repositories.health.bumpAccountRequestCount).toHaveBeenCalledTimes(1);
  });
});
