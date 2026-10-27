import { describe, expect, it, mock } from "bun:test";
import type { Database } from "@opendum/database/client";

const noop = () => mock(async () => undefined);

const queries = {
  listEligibleAccounts: mock(async () => []),
  sharedAccounts: mock(async () => []),
  disabledIds: mock(async () => []),
  expiringAccounts: mock(async () => []),
  getForcedAccount: mock(async () => null),
  getQuotaAccount: mock(async () => null),
  credentialsById: mock(async () => null),
  ownerId: mock(async () => null),
  updateRefreshedCredentials: noop(),
  recordAccountError: noop(),
  disableFailedAccount: mock(async () => 0),
  bumpRequests: noop(),
  healthState: mock(async () => null),
  markFailed: noop(),
  setAccountCooldown: noop(),
  setAccountActive: noop(),
  markLimited: noop(),
  recordRequestError: noop(),
  markAccountSuccess: noop(),
  markRecovered: noop(),
  healthByAccount: mock(async () => []),
  getModelHealth: mock(async () => null),
  bumpCounters: noop(),
  setStatus: noop(),
  insertModelHealth: noop(),
  markUsageLimited: noop(),
  markSuccess: noop(),
  successStatus: noop(),
  recordFailure: noop(),
  failStatus: noop(),
  getCustomProvider: mock(async () => null),
  listCustomProviders: mock(async () => []),
  customModels: mock(async () => []),
  insertUsageLog: noop(),
  creditPointBalance: mock(async () => 10),
  debitPointBalance: mock(async () => 10),
  debitAllowNegative: mock(async () => 10),
  insertBalance: mock(async () => 0),
  insertPointTransaction: noop(),
  insertTransaction: mock(async () => 0),
  updateTransactionBalance: noop(),
  listOrphaned: mock(async () => []),
};

void mock.module("./queries/index.js", () => queries);

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
  it("binds the database for provider account queries", () => {
    const repo = new Accounts(database);
    repo.getForcedAccount("acct-1", "user-1");
    expect(lastCall(queries.getForcedAccount)).toEqual(["acct-1", "user-1", database]);
    repo.getQuotaAccount("acct-1", "user-1", "cline");
    expect(lastCall(queries.getQuotaAccount)).toEqual(["acct-1", "user-1", "cline", database]);
  });

  it("binds the database for model health queries", () => {
    const repo = new Health(database);
    repo.getModelHealth("acct-1", "gpt-4o");
    expect(lastCall(queries.getModelHealth)).toEqual(["acct-1", "gpt-4o", database]);
  });

  it("binds the database for custom provider queries", () => {
    const repo = new Customs(database);
    repo.getCustomProvider("user-1", "my-provider");
    expect(lastCall(queries.getCustomProvider)).toEqual(["user-1", "my-provider", database]);
  });

  it("passes usage and point params through unchanged", () => {
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
    usage.insertUsageLog(log);
    expect(lastCall(queries.insertUsageLog)).toEqual([log, database]);

    const points = new Points(database);
    const debit = { userId: "user-1", amount: 6, at: new Date(0) };
    points.debitPointBalance(debit);
    expect(lastCall(queries.debitPointBalance)).toEqual([debit, database]);
  });
});
