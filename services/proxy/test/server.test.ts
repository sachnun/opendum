import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import type { ProxyContext } from "../src/context.js";
import { createServer } from "../src/server.js";

// createServer pulls in the route graph, which reaches @opendum/database/queries.
// That module eagerly opens a pg pool at import time, so stub it to keep the test
// independent of DATABASE_URL (the handlers exercised here never query).
const db = vi.hoisted(() => {
  const noop = () => vi.fn(async () => undefined);
  return {
    bumpAccountRequestCount: noop(),
    deactivateAPIKey: noop(),
    disableFailedAccount: vi.fn(async () => 0),
    getAccountCredentialsByID: vi.fn(async () => null),
    getAccountHealthState: vi.fn(async () => null),
    getAccountOwnerUserID: vi.fn(async () => null),
    getForcedAccount: vi.fn(async () => null),
    getModelHealth: vi.fn(async () => null),
    getCustomProvider: vi.fn(async () => null),
    listCustomProviderModels: vi.fn(async () => []),
    listCustomProviders: vi.fn(async () => []),
    getQuotaAccount: vi.fn(async () => null),
    insertModelHealth: noop(),
    insertUsageLog: noop(),
    listDisabledAccountIDs: vi.fn(async () => []),
    listEligibleAccounts: vi.fn(async () => []),
    listExpiringRefreshableAccounts: vi.fn(async () => []),
    listModelHealthByAccount: vi.fn(async () => []),
    listModelHealthByAccounts: vi.fn(async () => []),
    listSharedEligibleAccounts: vi.fn(async () => []),
    markAccountRecoveredByRotation: noop(),
    markAccountSuccess: noop(),
    markUsageLimitedHealth: noop(),
    recordAccountError: noop(),
    recordRequestError: noop(),
    setAccountActive: noop(),
    setAccountCooldown: noop(),
    setAccountHealthFailed: noop(),
    setAccountUsageLimited: noop(),
    updateModelHealthCounters: noop(),
    updateModelHealthFailure: noop(),
    updateModelHealthFailureWithStatus: noop(),
    updateModelHealthStatus: noop(),
    updateModelHealthSuccess: noop(),
    updateModelHealthSuccessWithStatus: noop(),
    updateRefreshedCredentials: noop(),
    creditPointBalance: noop(),
    debitPointBalance: vi.fn(async () => 10),
    debitPointBalanceAllowNegative: vi.fn(async () => 10),
    insertPointBalanceOnConflictDoNothing: vi.fn(async () => 0),
    insertPointTransaction: noop(),
    insertPointTransactionOnConflictDoNothing: vi.fn(async () => 0),
    updatePointTransactionBalance: noop(),
  };
});

vi.mock("@opendum/database/queries", () => db);

const context = {} as unknown as ProxyContext;

describe("cors middleware", () => {
  it("adds cors headers to successful responses", async () => {
    const app = createServer(context);
    const response = await app.request("/health");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("access-control-expose-headers"), "*");
  });

  it("adds cors headers to not found responses", async () => {
    const app = createServer(context);
    const response = await app.request("/v1/unknown");
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });

  it("answers preflight requests", async () => {
    const app = createServer(context);
    const response = await app.request("/v1/chat/completions", { method: "OPTIONS" });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });
});
