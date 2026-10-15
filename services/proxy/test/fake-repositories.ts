import { mock, type Mock } from "bun:test";
import type {
  CustomProviderPort,
  ModelHealthPort,
  PointPort,
  ProviderAccountPort,
  UsagePort,
} from "../core/repositories.js";

/** Turns a port into its mock shape, preserving each method signature. */
type Fakes<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : never;
};

/** Default implementation for lookups that find nothing. */
const absent = async () => null as never;

export type FakeRepositories = {
  accounts: Fakes<ProviderAccountPort>;
  health: Fakes<ModelHealthPort>;
  customProviders: Fakes<CustomProviderPort>;
  usage: Fakes<UsagePort>;
  points: Omit<Fakes<PointPort>, "transaction"> & { transaction: PointPort["transaction"] };
};

function fakeAccounts(): Fakes<ProviderAccountPort> {
  return {
    listEligibleAccounts: mock<ProviderAccountPort["listEligibleAccounts"]>(async () => []),
    listSharedEligibleAccounts: mock<ProviderAccountPort["listSharedEligibleAccounts"]>(async () => []),
    listDisabledAccountIDs: mock<ProviderAccountPort["listDisabledAccountIDs"]>(async () => []),
    listExpiringRefreshableAccounts: mock<ProviderAccountPort["listExpiringRefreshableAccounts"]>(async () => []),
    getForcedAccount: mock<ProviderAccountPort["getForcedAccount"]>(absent),
    getQuotaAccount: mock<ProviderAccountPort["getQuotaAccount"]>(absent),
    getAccountCredentialsByID: mock<ProviderAccountPort["getAccountCredentialsByID"]>(absent),
    getAccountOwnerUserID: mock<ProviderAccountPort["getAccountOwnerUserID"]>(absent),
    updateRefreshedCredentials: mock<ProviderAccountPort["updateRefreshedCredentials"]>(async () => undefined),
    recordAccountError: mock<ProviderAccountPort["recordAccountError"]>(async () => undefined),
    disableFailedAccount: mock<ProviderAccountPort["disableFailedAccount"]>(async () => 0),
  };
}

function fakeHealth(): Fakes<ModelHealthPort> {
  return {
    bumpAccountRequestCount: mock<ModelHealthPort["bumpAccountRequestCount"]>(async () => undefined),
    getAccountHealthState: mock<ModelHealthPort["getAccountHealthState"]>(absent),
    setAccountHealthFailed: mock<ModelHealthPort["setAccountHealthFailed"]>(async () => undefined),
    setAccountCooldown: mock<ModelHealthPort["setAccountCooldown"]>(async () => undefined),
    setAccountActive: mock<ModelHealthPort["setAccountActive"]>(async () => undefined),
    setAccountUsageLimited: mock<ModelHealthPort["setAccountUsageLimited"]>(async () => undefined),
    recordRequestError: mock<ModelHealthPort["recordRequestError"]>(async () => undefined),
    markAccountSuccess: mock<ModelHealthPort["markAccountSuccess"]>(async () => undefined),
    markAccountRecoveredByRotation: mock<ModelHealthPort["markAccountRecoveredByRotation"]>(async () => undefined),
    listModelHealthByAccount: mock<ModelHealthPort["listModelHealthByAccount"]>(async () => []),
    getModelHealth: mock<ModelHealthPort["getModelHealth"]>(absent),
    updateModelHealthCounters: mock<ModelHealthPort["updateModelHealthCounters"]>(async () => undefined),
    updateModelHealthStatus: mock<ModelHealthPort["updateModelHealthStatus"]>(async () => undefined),
    insertModelHealth: mock<ModelHealthPort["insertModelHealth"]>(async () => undefined),
    markUsageLimitedHealth: mock<ModelHealthPort["markUsageLimitedHealth"]>(async () => undefined),
    updateModelHealthSuccess: mock<ModelHealthPort["updateModelHealthSuccess"]>(async () => undefined),
    updateModelHealthSuccessWithStatus: mock<ModelHealthPort["updateModelHealthSuccessWithStatus"]>(async () => undefined),
    updateModelHealthFailure: mock<ModelHealthPort["updateModelHealthFailure"]>(async () => undefined),
    updateModelHealthFailureWithStatus: mock<ModelHealthPort["updateModelHealthFailureWithStatus"]>(async () => undefined),
  };
}

function fakeCustomProviders(): Fakes<CustomProviderPort> {
  return {
    listCustomProviders: mock<CustomProviderPort["listCustomProviders"]>(async () => []),
    getCustomProvider: mock<CustomProviderPort["getCustomProvider"]>(absent),
    listCustomProviderModels: mock<CustomProviderPort["listCustomProviderModels"]>(async () => []),
  };
}

function fakeUsage(): Fakes<UsagePort> {
  return {
    insertUsageLog: mock<UsagePort["insertUsageLog"]>(async () => undefined),
  };
}

function fakePoints(): FakeRepositories["points"] {
  const points: FakeRepositories["points"] = {
    creditPointBalance: mock<PointPort["creditPointBalance"]>(async () => 10),
    debitPointBalance: mock<PointPort["debitPointBalance"]>(async () => 10),
    debitPointBalanceAllowNegative: mock<PointPort["debitPointBalanceAllowNegative"]>(async () => 10),
    insertPointBalanceOnConflictDoNothing: mock<PointPort["insertPointBalanceOnConflictDoNothing"]>(async () => 0),
    insertPointTransaction: mock<PointPort["insertPointTransaction"]>(async () => undefined),
    insertPointTransactionOnConflictDoNothing: mock<PointPort["insertPointTransactionOnConflictDoNothing"]>(async () => 0),
    updatePointTransactionBalance: mock<PointPort["updatePointTransactionBalance"]>(async () => undefined),
    transaction: (run) => run(points),
  };
  return points;
}

/** In-memory doubles for the proxy's database ports, with call recording. */
export function createFakeRepositories(): FakeRepositories {
  return {
    accounts: fakeAccounts(),
    health: fakeHealth(),
    customProviders: fakeCustomProviders(),
    usage: fakeUsage(),
    points: fakePoints(),
  };
}
