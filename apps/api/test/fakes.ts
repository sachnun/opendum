import { mock, type Mock } from "bun:test";
import type {
  CustomPort,
  HealthPort,
  PointPort,
  AccountPort,
  UsagePort,
} from "../core/repositories.js";

/** Turns a port into its mock shape, preserving each method signature. */
type Stub<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : never;
};

/** Default implementation for lookups that find nothing. */
const absent = async () => null as never;

export type Fakes = {
  accounts: Stub<AccountPort>;
  health: Stub<HealthPort>;
  customProviders: Stub<CustomPort>;
  usage: Stub<UsagePort>;
  points: Omit<Stub<PointPort>, "transaction"> & { transaction: PointPort["transaction"] };
};

function accounts(): Stub<AccountPort> {
  return {
    listEligibleAccounts: mock<AccountPort["listEligibleAccounts"]>(async () => []),
    listSharedEligibleAccounts: mock<AccountPort["listSharedEligibleAccounts"]>(async () => []),
    listDisabledAccountIDs: mock<AccountPort["listDisabledAccountIDs"]>(async () => []),
    listExpiringRefreshableAccounts: mock<AccountPort["listExpiringRefreshableAccounts"]>(async () => []),
    getForcedAccount: mock<AccountPort["getForcedAccount"]>(absent),
    getQuotaAccount: mock<AccountPort["getQuotaAccount"]>(absent),
    getAccountCredentialsByID: mock<AccountPort["getAccountCredentialsByID"]>(absent),
    getAccountOwnerUserID: mock<AccountPort["getAccountOwnerUserID"]>(absent),
    updateRefreshedCredentials: mock<AccountPort["updateRefreshedCredentials"]>(async () => undefined),
    recordAccountError: mock<AccountPort["recordAccountError"]>(async () => undefined),
    disableFailedAccount: mock<AccountPort["disableFailedAccount"]>(async () => 0),
  };
}

function health(): Stub<HealthPort> {
  return {
    bumpAccountRequestCount: mock<HealthPort["bumpAccountRequestCount"]>(async () => undefined),
    getAccountHealthState: mock<HealthPort["getAccountHealthState"]>(absent),
    setAccountHealthFailed: mock<HealthPort["setAccountHealthFailed"]>(async () => undefined),
    setAccountCooldown: mock<HealthPort["setAccountCooldown"]>(async () => undefined),
    setAccountActive: mock<HealthPort["setAccountActive"]>(async () => undefined),
    setAccountUsageLimited: mock<HealthPort["setAccountUsageLimited"]>(async () => undefined),
    recordRequestError: mock<HealthPort["recordRequestError"]>(async () => undefined),
    markAccountSuccess: mock<HealthPort["markAccountSuccess"]>(async () => undefined),
    markAccountRecoveredByRotation: mock<HealthPort["markAccountRecoveredByRotation"]>(async () => undefined),
    listModelHealthByAccount: mock<HealthPort["listModelHealthByAccount"]>(async () => []),
    getModelHealth: mock<HealthPort["getModelHealth"]>(absent),
    updateModelHealthCounters: mock<HealthPort["updateModelHealthCounters"]>(async () => undefined),
    updateModelHealthStatus: mock<HealthPort["updateModelHealthStatus"]>(async () => undefined),
    insertModelHealth: mock<HealthPort["insertModelHealth"]>(async () => undefined),
    markUsageLimitedHealth: mock<HealthPort["markUsageLimitedHealth"]>(async () => undefined),
    updateModelHealthSuccess: mock<HealthPort["updateModelHealthSuccess"]>(async () => undefined),
    updateModelHealthSuccessWithStatus: mock<HealthPort["updateModelHealthSuccessWithStatus"]>(async () => undefined),
    updateModelHealthFailure: mock<HealthPort["updateModelHealthFailure"]>(async () => undefined),
    updateModelHealthFailureWithStatus: mock<HealthPort["updateModelHealthFailureWithStatus"]>(async () => undefined),
  };
}

function customProviders(): Stub<CustomPort> {
  return {
    listCustomProviders: mock<CustomPort["listCustomProviders"]>(async () => []),
    getCustomProvider: mock<CustomPort["getCustomProvider"]>(absent),
    listCustomProviderModels: mock<CustomPort["listCustomProviderModels"]>(async () => []),
  };
}

function usage(): Stub<UsagePort> {
  return {
    insertUsageLog: mock<UsagePort["insertUsageLog"]>(async () => undefined),
  };
}

function points(): Fakes["points"] {
  const points: Fakes["points"] = {
    creditPointBalance: mock<PointPort["creditPointBalance"]>(async () => 10),
    debitPointBalance: mock<PointPort["debitPointBalance"]>(async () => 10),
    debitPointBalanceAllowNegative: mock<PointPort["debitPointBalanceAllowNegative"]>(async () => 10),
    insertPointBalanceOnConflictDoNothing: mock<PointPort["insertPointBalanceOnConflictDoNothing"]>(async () => 0),
    insertPointTransaction: mock<PointPort["insertPointTransaction"]>(async () => undefined),
    insertPointTransactionOnConflictDoNothing: mock<PointPort["insertPointTransactionOnConflictDoNothing"]>(async () => 0),
    updatePointTransactionBalance: mock<PointPort["updatePointTransactionBalance"]>(async () => undefined),
    listOrphanedRoamingDebits: mock<PointPort["listOrphanedRoamingDebits"]>(async () => []),
    transaction: (run) => run(points),
  };
  return points;
}

/** In-memory doubles for the proxy's database ports, with call recording. */
export function fakes(): Fakes {
  return {
    accounts: accounts(),
    health: health(),
    customProviders: customProviders(),
    usage: usage(),
    points: points(),
  };
}
