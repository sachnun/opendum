import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { Database } from "#database/client.ts";

mock.module("#database/client.ts", {
  namedExports: { db: {} },
});

const {
  deactivateAPIKey,
  getAPIKeyByHash,
  getAPIKeyFreshnessByID,
  listAPIKeyRateLimits,
  touchAPIKeyLastUsed,
} = await import("#database/queries/api-key.ts");
const {
  listActiveAccountTiers,
  listDisabledModelsByAccounts,
  listDisabledModelsByUser,
  listSharedAccounts,
} = await import("#database/queries/availability.ts");
const {
  getCustomProvider,
  listCustomProviderModels,
  listCustomProviders,
} = await import("#database/queries/custom.ts");
const {
  bumpAccountRequestCount,
  clearModelQuotaLock,
  getAccountHealthState,
  getModelHealth,
  insertModelHealth,
  listModelHealthByAccount,
  listModelHealthByAccounts,
  lockModelQuota,
  markAccountRecoveredByRotation,
  markAccountSuccess,
  markUsageLimitedHealth,
  recordRequestError,
  setAccountActive,
  setAccountCooldown,
  setAccountHealthFailed,
  setAccountUsageLimited,
  updateModelHealthCounters,
  updateModelHealthFailure,
  updateModelHealthFailureWithStatus,
  updateModelHealthStatus,
  updateModelHealthSuccess,
  updateModelHealthSuccessWithStatus,
} = await import("#database/queries/model-health.ts");
const {
  disableFailedAccount,
  getAccountCredentialsByID,
  getAccountOwnerUserID,
  getForcedAccount,
  getQuotaAccount,
  listDisabledAccountIDs,
  listEligibleAccounts,
  listExpiringRefreshableAccounts,
  listSharedEligibleAccounts,
  recordAccountError,
  updateAntigravityAccountInfo,
  updateCodexAccountID,
  updateRefreshedCredentials,
} = await import("#database/queries/provider-account.ts");
const {
  creditPointBalance,
  debitPointBalance,
  debitPointBalanceAllowNegative,
  insertPointBalanceOnConflictDoNothing,
  insertPointTransaction,
  insertPointTransactionOnConflictDoNothing,
  insertUsageLog,
  updatePointTransactionBalance,
} = await import("#database/queries/usage-points.ts");

type FakeDb = { db: Database; calls: string[] };

function fakeDb(...results: unknown[]): FakeDb {
  const calls: string[] = [];
  const queue = [...results];
  const ref: { proxy: unknown } = { proxy: null };
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (value: unknown) => void) => resolve(queue.length > 1 ? queue.shift() : queue[0]);
      }
      return () => {
        calls.push(String(prop));
        return ref.proxy;
      };
    },
  };
  const proxy = new Proxy(Object.create(null) as object, handler);
  ref.proxy = proxy;
  return { db: proxy as Database, calls };
}

const now = new Date("2026-01-01T00:00:00Z");

describe("api key queries", () => {
  it("reads keys by hash and freshness", async () => {
    const byHash = fakeDb([{ id: "k1" }]);
    assert.deepEqual(await getAPIKeyByHash("h", byHash.db), { id: "k1" });
    assert.equal(await getAPIKeyByHash("h", fakeDb([]).db), null);

    const freshness = fakeDb([{ id: "k1" }]);
    assert.deepEqual(await getAPIKeyFreshnessByID("k1", freshness.db), { id: "k1" });
    assert.equal(await getAPIKeyFreshnessByID("k1", fakeDb([]).db), null);
  });

  it("lists rate limits and writes updates", async () => {
    const limits = fakeDb([{ target: "x" }]);
    assert.deepEqual(await listAPIKeyRateLimits("k1", limits.db), [{ target: "x" }]);

    const touch = fakeDb(undefined);
    await touchAPIKeyLastUsed("k1", touch.db);
    assert.ok(touch.calls.includes("update") && touch.calls.includes("where"));

    const deactivate = fakeDb(undefined);
    await deactivateAPIKey("k1", deactivate.db);
    assert.ok(deactivate.calls.includes("update"));
  });
});

describe("availability queries", () => {
  it("lists disabled models and tiers", async () => {
    const disabled = fakeDb([{ model: "m1" }, { model: "m2" }]);
    assert.deepEqual(await listDisabledModelsByUser("u", disabled.db), ["m1", "m2"]);

    const tiers = fakeDb([{ id: "a" }]);
    assert.deepEqual(await listActiveAccountTiers("u", now, false, tiers.db), [{ id: "a" }]);
    const allTiers = fakeDb([{ id: "b" }]);
    assert.deepEqual(await listActiveAccountTiers("u", now, true, allTiers.db), [{ id: "b" }]);
  });

  it("handles empty account lists", async () => {
    assert.deepEqual(await listDisabledModelsByAccounts([], fakeDb([]).db), []);
    const rows = fakeDb([{ model: "m" }]);
    assert.deepEqual(await listDisabledModelsByAccounts(["a"], rows.db), [{ model: "m" }]);
  });

  it("lists shared accounts", async () => {
    const rows = fakeDb([{ id: "a" }]);
    assert.deepEqual(await listSharedAccounts("u", now, rows.db), [{ id: "a" }]);
    assert.ok(rows.calls.includes("innerJoin"));
  });
});

describe("custom provider queries", () => {
  it("reads providers and models", async () => {
    const providers = fakeDb([{ id: "p" }]);
    assert.deepEqual(await listCustomProviders("u", providers.db), [{ id: "p" }]);

    const one = fakeDb([{ id: "p" }]);
    assert.deepEqual(await getCustomProvider("u", "slug", one.db), { id: "p" });
    assert.equal(await getCustomProvider("u", "slug", fakeDb([]).db), null);

    const models = fakeDb([{ id: "m" }]);
    assert.deepEqual(await listCustomProviderModels("p", models.db), [{ id: "m" }]);
  });
});

describe("model health queries", () => {
  it("runs account-level updates", async () => {
    for (const run of [
      () => bumpAccountRequestCount({ id: "a", at: now }, fakeDb(undefined).db),
      () => setAccountHealthFailed({ id: "a", consecutiveErrors: 1, status: "failed", at: now }, fakeDb(undefined).db),
      () => setAccountCooldown({ id: "a", status: "cooldown", at: now, consecutiveErrors: 1, disabledUntil: now }, fakeDb(undefined).db),
      () => setAccountActive({ id: "a", status: "active", at: now, consecutiveErrors: 0 }, fakeDb(undefined).db),
      () => setAccountUsageLimited({ id: "a", disabledUntil: now, status: "limited", at: now }, fakeDb(undefined).db),
      () => recordRequestError({ id: "a", at: now, code: 429 }, fakeDb(undefined).db),
      () => markAccountSuccess({ id: "a", at: now }, fakeDb(undefined).db),
      () => markAccountRecoveredByRotation({ id: "a", at: now, beforeOrAt: now }, fakeDb(undefined).db),
    ]) {
      await run();
    }
    const state = fakeDb([{ id: "a" }]);
    assert.deepEqual(await getAccountHealthState("a", state.db), { id: "a" });
    assert.equal(await getAccountHealthState("a", fakeDb([]).db), null);
  });

  it("runs model-level updates and reads", async () => {
    const healthy = { id: "h", providerAccountId: "a", model: "m", consecutiveErrors: 0, unhealthyCountUpdatedAt: now };
    for (const run of [
      () => updateModelHealthCounters(healthy, fakeDb(undefined).db),
      () => updateModelHealthStatus({ ...healthy, status: "active", statusChangedAt: now }, fakeDb(undefined).db),
      () => insertModelHealth({ ...healthy, status: "active", lastErrorAt: null, lastErrorCode: null, createdAt: now, updatedAt: now }, fakeDb(undefined).db),
      () => markUsageLimitedHealth({ providerAccountId: "a", model: "m", status: "limited", at: now, consecutiveErrors: 1 }, fakeDb(undefined).db),
      () => updateModelHealthSuccess({ id: "h", consecutiveErrors: 0, lastSuccessAt: now, unhealthyCountUpdatedAt: now }, fakeDb(undefined).db),
      () => updateModelHealthSuccessWithStatus({ id: "h", consecutiveErrors: 0, lastSuccessAt: now, unhealthyCountUpdatedAt: now, status: "active", statusChangedAt: now }, fakeDb(undefined).db),
      () => updateModelHealthFailure({ id: "h", consecutiveErrors: 1, lastErrorAt: now, lastErrorCode: 500, unhealthyCountUpdatedAt: now }, fakeDb(undefined).db),
      () => updateModelHealthFailureWithStatus({ id: "h", consecutiveErrors: 1, lastErrorAt: now, lastErrorCode: 500, unhealthyCountUpdatedAt: now, status: "failed", statusChangedAt: now }, fakeDb(undefined).db),
      () => lockModelQuota({ id: "h", providerAccountId: "a", model: "m", quotaLockedUntil: now, quotaLockReason: "quota", at: now }, fakeDb(undefined).db),
      () => clearModelQuotaLock({ providerAccountId: "a", model: "m" }, fakeDb(undefined).db),
    ]) {
      await run();
    }

    assert.deepEqual(await listModelHealthByAccounts({ accountIds: [], models: ["m"] }, fakeDb([]).db), []);
    const listed = fakeDb([{ id: "h" }]);
    assert.deepEqual(await listModelHealthByAccounts({ accountIds: ["a"], models: ["m"] }, listed.db), [{ id: "h" }]);
    const byAccount = fakeDb([{ id: "h" }]);
    assert.deepEqual(await listModelHealthByAccount("a", byAccount.db), [{ id: "h" }]);
    const health = fakeDb([{ id: "h" }]);
    assert.deepEqual(await getModelHealth("a", "m", health.db), { id: "h" });
    assert.equal(await getModelHealth("a", "m", fakeDb([]).db), null);
  });
});

describe("provider account queries", () => {
  it("reads quota, credentials, owners and forced accounts", async () => {
    const quota = fakeDb([{ id: "a" }]);
    assert.deepEqual(await getQuotaAccount("a", "u", "kiro", quota.db), { id: "a" });
    assert.equal(await getQuotaAccount("a", "u", "kiro", fakeDb([]).db), null);

    const credentials = fakeDb([{ id: "a" }]);
    assert.deepEqual(await getAccountCredentialsByID("a", credentials.db), { id: "a" });
    assert.equal(await getAccountCredentialsByID("a", fakeDb([]).db), null);

    const owner = fakeDb([{ userId: "u" }]);
    assert.equal(await getAccountOwnerUserID("a", owner.db), "u");
    assert.equal(await getAccountOwnerUserID("a", fakeDb([{}]).db), null);
    assert.equal(await getAccountOwnerUserID("a", fakeDb([]).db), null);

    const forced = fakeDb([{ id: "a" }]);
    assert.deepEqual(await getForcedAccount("a", "u", forced.db), { id: "a" });
    assert.equal(await getForcedAccount("a", "u", fakeDb([]).db), null);
  });

  it("lists eligible accounts with filtering", async () => {
    const rows = fakeDb([
      { id: "a" },
      { id: "b" },
    ]);
    const params = {
      userId: "u",
      providers: ["kiro"],
      now,
      excludeIds: ["b"],
      excludeProviders: [],
      useWhitelist: false,
      useBlacklist: false,
      accountIds: [],
    };
    assert.deepEqual(await listEligibleAccounts(params, rows.db), [{ id: "a" }]);

    const kept = fakeDb([{ id: "a" }]);
    assert.deepEqual(await listEligibleAccounts({ ...params, excludeIds: [] }, kept.db), [{ id: "a" }]);
    await listEligibleAccounts({ ...params, excludeProviders: ["x"], useWhitelist: true, accountIds: ["a"] }, fakeDb([]).db);
    await listEligibleAccounts({ ...params, excludeIds: [], excludeProviders: ["x"], useBlacklist: true, accountIds: ["a"] }, fakeDb([]).db);
  });

  it("lists shared and expiring accounts", async () => {
    const shared = fakeDb([{ id: "a" }]);
    const sharedParams = { userId: "u", providers: ["kiro"], now, excludeIds: [], excludeProviders: [] };
    assert.deepEqual(await listSharedEligibleAccounts(sharedParams, shared.db), [{ id: "a" }]);
    await listSharedEligibleAccounts({ ...sharedParams, excludeProviders: ["x"] }, fakeDb([]).db);

    const expiring = fakeDb([{ id: "a" }]);
    assert.deepEqual(await listExpiringRefreshableAccounts({ provider: "kiro", now, expiresBefore: now, batchLimit: 5 }, expiring.db), [{ id: "a" }]);
  });

  it("runs account credential updates and error recording", async () => {
    const account = fakeDb(undefined);
    await updateRefreshedCredentials(
      { id: "a", accessToken: "at", refreshToken: "rt", expiresAt: now, projectId: null, tier: null, email: null, accountId: null },
      account.db
    );
    assert.ok(account.calls.includes("update"));

    await recordAccountError({ id: "a", at: now, code: 500 }, fakeDb(undefined).db);
    assert.equal(await disableFailedAccount({ id: "a", status: "failed", at: now }, fakeDb({ rowCount: 2 }).db), 2);
    assert.equal(await disableFailedAccount({ id: "a", status: "failed", at: now }, fakeDb({}).db), 0);
    await updateCodexAccountID({ id: "a", accountId: null }, fakeDb(undefined).db);
    await updateAntigravityAccountInfo({ id: "a", projectId: "p", tier: "pro", email: null }, fakeDb(undefined).db);
    assert.deepEqual(await listDisabledAccountIDs({ accountIds: [], models: ["m"] }, fakeDb([]).db), []);
    const disabled = fakeDb([{ model: "m" }]);
    assert.deepEqual(await listDisabledAccountIDs({ accountIds: ["a"], models: ["m"] }, disabled.db), [{ model: "m" }]);
  });
});

describe("usage point queries", () => {
  it("inserts usage logs and transactions", async () => {
    await insertUsageLog(
      {
        userId: "u",
        providerAccountId: null,
        proxyApiKeyId: null,
        model: "m",
        inputTokens: 1,
        outputTokens: 2,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        statusCode: 200,
        duration: 10,
        createdAt: now,
      },
      fakeDb(undefined).db
    );

    await insertPointTransaction(
      { userId: "u", amount: 1, type: "debit", balanceAfter: 9, idempotencyKey: null, usageLogId: null, createdAt: now },
      fakeDb(undefined).db
    );

    assert.equal(
      await insertPointTransactionOnConflictDoNothing(
        { userId: "u", amount: 1, type: "debit", balanceAfter: 9, idempotencyKey: null, usageLogId: null, createdAt: now },
        fakeDb({ rowCount: 3 }).db
      ),
      3
    );
    assert.equal(
      await insertPointTransactionOnConflictDoNothing(
        { userId: "u", amount: 1, type: "debit", balanceAfter: 9, idempotencyKey: null, usageLogId: null, createdAt: now },
        fakeDb({}).db
      ),
      0
    );

    await updatePointTransactionBalance({ id: "t", balanceAfter: 5 }, fakeDb(undefined).db);
    assert.equal(await insertPointBalanceOnConflictDoNothing({ userId: "u", balance: 1, createdAt: now, updatedAt: now }, fakeDb({ rowCount: 1 }).db), 1);
    assert.equal(await insertPointBalanceOnConflictDoNothing({ userId: "u", balance: 1, createdAt: now, updatedAt: now }, fakeDb({}).db), 0);
  });

  it("debits and credits balances", async () => {
    assert.equal(await debitPointBalance({ userId: "u", amount: 1, at: now }, fakeDb([{ balance: 5 }]).db), 5);
    assert.equal(await debitPointBalance({ userId: "u", amount: 1, at: now }, fakeDb([]).db), null);
    assert.equal(await debitPointBalanceAllowNegative({ userId: "u", amount: 1, at: now }, fakeDb([{ balance: -1 }]).db), -1);
    assert.equal(await creditPointBalance({ userId: "u", amount: 1, at: now }, fakeDb([{ balance: 7 }]).db), 7);
    assert.equal(await creditPointBalance({ userId: "u", amount: 1, at: now }, fakeDb([]).db), null);
  });
});
