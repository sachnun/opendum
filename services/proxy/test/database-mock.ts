import { mock } from "bun:test";

export function createDatabaseQueryMocks() {
  const asyncNoop = () => mock(async () => undefined);
  const db = {
    bumpAccountRequestCount: asyncNoop(),
    deactivateAPIKey: asyncNoop(),
    disableFailedAccount: mock(async () => 0),
    getAccountCredentialsByID: mock(async () => null),
    getAccountHealthState: mock(async () => null),
    getAccountOwnerUserID: mock(async () => null),
    getForcedAccount: mock(async () => null),
    getModelHealth: mock(async () => null),
    getCustomProvider: mock(async () => null),
    listCustomProviderModels: mock(async () => []),
    listCustomProviders: mock(async () => []),
    getQuotaAccount: mock(async () => null),
    insertModelHealth: asyncNoop(),
    insertUsageLog: asyncNoop(),
    listDisabledAccountIDs: mock(async () => []),
    listEligibleAccounts: mock(async () => []),
    listExpiringRefreshableAccounts: mock(async () => []),
    listModelHealthByAccount: mock(async () => []),
    listModelHealthByAccounts: mock(async () => []),
    listSharedEligibleAccounts: mock(async () => []),
    markAccountRecoveredByRotation: asyncNoop(),
    markAccountSuccess: asyncNoop(),
    markUsageLimitedHealth: asyncNoop(),
    recordAccountError: asyncNoop(),
    recordRequestError: asyncNoop(),
    setAccountActive: asyncNoop(),
    setAccountCooldown: asyncNoop(),
    setAccountHealthFailed: asyncNoop(),
    setAccountUsageLimited: asyncNoop(),
    updateModelHealthCounters: asyncNoop(),
    updateModelHealthFailure: asyncNoop(),
    updateModelHealthFailureWithStatus: asyncNoop(),
    updateModelHealthStatus: asyncNoop(),
    updateModelHealthSuccess: asyncNoop(),
    updateModelHealthSuccessWithStatus: asyncNoop(),
    updateRefreshedCredentials: asyncNoop(),
    creditPointBalance: asyncNoop(),
    debitPointBalance: mock(async () => 10),
    debitPointBalanceAllowNegative: mock(async () => 10),
    insertPointBalanceOnConflictDoNothing: mock(async () => 0),
    insertPointTransaction: asyncNoop(),
    insertPointTransactionOnConflictDoNothing: mock(async () => 0),
    updatePointTransactionBalance: asyncNoop(),
  };

  return db;
}

export type DatabaseQueryMocks = ReturnType<typeof createDatabaseQueryMocks>;
