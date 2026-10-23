import { describe, expect, it, mock } from "bun:test";
import type { Database } from "./client.js";

const noop = () => mock(async () => undefined);

const queries = {
  // provider account
  listEligibleAccounts: mock(async () => []),
  listSharedEligibleAccounts: mock(async () => []),
  listDisabledAccountIDs: mock(async () => []),
  listExpiringRefreshableAccounts: mock(async () => []),
  getForcedAccount: mock(async () => null),
  getQuotaAccount: mock(async () => null),
  getAccountCredentialsByID: mock(async () => null),
  getAccountOwnerUserID: mock(async () => null),
  updateRefreshedCredentials: noop(),
  recordAccountError: noop(),
  disableFailedAccount: mock(async () => 0),
  // model health
  bumpAccountRequestCount: noop(),
  getAccountHealthState: mock(async () => null),
  setAccountHealthFailed: noop(),
  setAccountCooldown: noop(),
  setAccountActive: noop(),
  setAccountUsageLimited: noop(),
  recordRequestError: noop(),
  markAccountSuccess: noop(),
  markAccountRecoveredByRotation: noop(),
  listModelHealthByAccount: mock(async () => []),
  getModelHealth: mock(async () => null),
  updateModelHealthCounters: noop(),
  updateModelHealthStatus: noop(),
  insertModelHealth: noop(),
  markUsageLimitedHealth: noop(),
  updateModelHealthSuccess: noop(),
  updateModelHealthSuccessWithStatus: noop(),
  updateModelHealthFailure: noop(),
  updateModelHealthFailureWithStatus: noop(),
  // custom provider
  getCustomProvider: mock(async () => null),
  listCustomProviders: mock(async () => []),
  listCustomProviderModels: mock(async () => []),
  // usage
  insertUsageLog: noop(),
  // points
  creditPointBalance: mock(async () => 10),
  debitPointBalance: mock(async () => 10),
  debitPointBalanceAllowNegative: mock(async () => 10),
  insertPointBalanceOnConflictDoNothing: mock(async () => 0),
  insertPointTransaction: noop(),
  insertPointTransactionOnConflictDoNothing: mock(async () => 0),
  updatePointTransactionBalance: noop(),
  listOrphanedRoamingDebits: mock(async () => []),
};

mock.module("./queries/index.js", () => queries);

const {
  Customs,
  Health,
  Points,
  Accounts,
  Usage,
} = await import("./repositories/index.js");

const database = { name: "db" } as unknown as Database;

const lastCall = (fn: { mock: { calls: unknown[][] } }): unknown[] => {
  const calls = fn.mock.calls;
  return (calls[calls.length - 1] ?? []) as unknown[];
};

describe("repositories", () => {
  it("binds the database for provider account queries", async () => {
    const repo = new Accounts(database);
    await repo.getForcedAccount("acct-1", "user-1");
    expect(lastCall(queries.getForcedAccount)).toEqual(["acct-1", "user-1", database]);
    await repo.getQuotaAccount("acct-1", "user-1", "cline");
    expect(lastCall(queries.getQuotaAccount)).toEqual(["acct-1", "user-1", "cline", database]);
  });

  it("binds the database for model health queries", async () => {
    const repo = new Health(database);
    await repo.getModelHealth("acct-1", "gpt-4o");
    expect(lastCall(queries.getModelHealth)).toEqual(["acct-1", "gpt-4o", database]);
  });

  it("binds the database for custom provider queries", async () => {
    const repo = new Customs(database);
    await repo.getCustomProvider("user-1", "my-provider");
    expect(lastCall(queries.getCustomProvider)).toEqual(["user-1", "my-provider", database]);
  });

  it("passes usage and point params through unchanged", async () => {
    const usage = new Usage(database);
    const log = {
      userId: "user-1",
      providerAccountId: null,
      proxyApiKeyId: null,
      model: "gpt-4o",
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      statusCode: 200,
      duration: 120,
      createdAt: new Date(0),
    };
    await usage.insertUsageLog(log);
    expect(lastCall(queries.insertUsageLog)).toEqual([log, database]);

    const points = new Points(database);
    const debit = { userId: "user-1", amount: 6, at: new Date(0) };
    await points.debitPointBalance(debit);
    expect(lastCall(queries.debitPointBalance)).toEqual([debit, database]);
  });
});
