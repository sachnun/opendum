import { mock, type Mock } from "bun:test";
import { Effect } from "effect";
import type {
  CustomPort,
  HealthPort,
  PointPort,
  AccountPort,
  UsagePort,
} from "../core/repositories.js";

type Stub<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : never;
};

const absent = () => Effect.succeed(null as never);

export type Fakes = {
  accounts: Stub<AccountPort>;
  health: Stub<HealthPort>;
  customProviders: Stub<CustomPort>;
  usage: Stub<UsagePort>;
  points: Omit<Stub<PointPort>, "transaction"> & { transaction: PointPort["transaction"] };
};

function accounts(): Stub<AccountPort> {
  return {
    listEligibleAccounts: mock<AccountPort["listEligibleAccounts"]>(() => Effect.succeed([])),
    listSharedEligibleAccounts: mock<AccountPort["listSharedEligibleAccounts"]>(() => Effect.succeed([])),
    listDisabledAccountIDs: mock<AccountPort["listDisabledAccountIDs"]>(() => Effect.succeed([])),
    listExpiringRefreshableAccounts: mock<AccountPort["listExpiringRefreshableAccounts"]>(() => Effect.succeed([])),
    getForcedAccount: mock<AccountPort["getForcedAccount"]>(absent),
    getQuotaAccount: mock<AccountPort["getQuotaAccount"]>(absent),
    getAccountCredentialsByID: mock<AccountPort["getAccountCredentialsByID"]>(absent),
    getAccountOwnerUserID: mock<AccountPort["getAccountOwnerUserID"]>(absent),
    updateRefreshedCredentials: mock<AccountPort["updateRefreshedCredentials"]>(() => Effect.succeed(undefined)),
    recordAccountError: mock<AccountPort["recordAccountError"]>(() => Effect.succeed(undefined)),
    disableFailedAccount: mock<AccountPort["disableFailedAccount"]>(() => Effect.succeed(0)),
  };
}

function health(): Stub<HealthPort> {
  return {
    bumpAccountRequestCount: mock<HealthPort["bumpAccountRequestCount"]>(() => Effect.succeed(undefined)),
    getAccountHealthState: mock<HealthPort["getAccountHealthState"]>(absent),
    setAccountHealthFailed: mock<HealthPort["setAccountHealthFailed"]>(() => Effect.succeed(undefined)),
    setAccountCooldown: mock<HealthPort["setAccountCooldown"]>(() => Effect.succeed(undefined)),
    setAccountActive: mock<HealthPort["setAccountActive"]>(() => Effect.succeed(undefined)),
    setAccountUsageLimited: mock<HealthPort["setAccountUsageLimited"]>(() => Effect.succeed(undefined)),
    recordRequestError: mock<HealthPort["recordRequestError"]>(() => Effect.succeed(undefined)),
    markAccountSuccess: mock<HealthPort["markAccountSuccess"]>(() => Effect.succeed(undefined)),
    markAccountRecoveredByRotation: mock<HealthPort["markAccountRecoveredByRotation"]>(() => Effect.succeed(undefined)),
    listModelHealthByAccount: mock<HealthPort["listModelHealthByAccount"]>(() => Effect.succeed([])),
    getModelHealth: mock<HealthPort["getModelHealth"]>(absent),
    updateModelHealthCounters: mock<HealthPort["updateModelHealthCounters"]>(() => Effect.succeed(undefined)),
    updateModelHealthStatus: mock<HealthPort["updateModelHealthStatus"]>(() => Effect.succeed(undefined)),
    insertModelHealth: mock<HealthPort["insertModelHealth"]>(() => Effect.succeed(undefined)),
    markUsageLimitedHealth: mock<HealthPort["markUsageLimitedHealth"]>(() => Effect.succeed(undefined)),
    updateModelHealthSuccess: mock<HealthPort["updateModelHealthSuccess"]>(() => Effect.succeed(undefined)),
    updateModelHealthSuccessWithStatus: mock<HealthPort["updateModelHealthSuccessWithStatus"]>(() => Effect.succeed(undefined)),
    updateModelHealthFailure: mock<HealthPort["updateModelHealthFailure"]>(() => Effect.succeed(undefined)),
    updateModelHealthFailureWithStatus: mock<HealthPort["updateModelHealthFailureWithStatus"]>(() => Effect.succeed(undefined)),
  };
}

function customProviders(): Stub<CustomPort> {
  return {
    listCustomProviders: mock<CustomPort["listCustomProviders"]>(() => Effect.succeed([])),
    getCustomProvider: mock<CustomPort["getCustomProvider"]>(absent),
    listCustomProviderModels: mock<CustomPort["listCustomProviderModels"]>(() => Effect.succeed([])),
  };
}

function usage(): Stub<UsagePort> {
  return {
    insertUsageLog: mock<UsagePort["insertUsageLog"]>(() => Effect.succeed(undefined)),
  };
}

function points(): Fakes["points"] {
  const points: Fakes["points"] = {
    creditPointBalance: mock<PointPort["creditPointBalance"]>(() => Effect.succeed(10)),
    debitPointBalance: mock<PointPort["debitPointBalance"]>(() => Effect.succeed(10)),
    debitPointBalanceAllowNegative: mock<PointPort["debitPointBalanceAllowNegative"]>(() => Effect.succeed(10)),
    insertPointBalanceOnConflictDoNothing: mock<PointPort["insertPointBalanceOnConflictDoNothing"]>(() => Effect.succeed(0)),
    insertPointTransaction: mock<PointPort["insertPointTransaction"]>(() => Effect.succeed(undefined)),
    insertPointTransactionOnConflictDoNothing: mock<PointPort["insertPointTransactionOnConflictDoNothing"]>(() => Effect.succeed(0)),
    updatePointTransactionBalance: mock<PointPort["updatePointTransactionBalance"]>(() => Effect.succeed(undefined)),
    listOrphanedRoamingDebits: mock<PointPort["listOrphanedRoamingDebits"]>(() => Effect.succeed([])),
    transaction: (run) => run(points),
  };
  return points;
}

export function fakes(): Fakes {
  return {
    accounts: accounts(),
    health: health(),
    customProviders: customProviders(),
    usage: usage(),
    points: points(),
  };
}
