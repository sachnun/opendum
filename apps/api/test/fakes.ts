import { mock, type Mock } from "bun:test";
import { Effect } from "effect";
import type {
  CustomPort,
  HealthPort,
  PointPort,
  AccountPort,
  UsagePort,
} from "@opendum/api/core/repositories";

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
    sharedAccounts: mock<AccountPort["sharedAccounts"]>(() => Effect.succeed([])),
    disabledIds: mock<AccountPort["disabledIds"]>(() => Effect.succeed([])),
    expiringAccounts: mock<AccountPort["expiringAccounts"]>(() => Effect.succeed([])),
    getForcedAccount: mock<AccountPort["getForcedAccount"]>(absent),
    getQuotaAccount: mock<AccountPort["getQuotaAccount"]>(absent),
    credentialsById: mock<AccountPort["credentialsById"]>(absent),
    ownerId: mock<AccountPort["ownerId"]>(absent),
    updateRefreshedCredentials: mock<AccountPort["updateRefreshedCredentials"]>(() => Effect.succeed(undefined)),
    recordAccountError: mock<AccountPort["recordAccountError"]>(() => Effect.succeed(undefined)),
    disableFailedAccount: mock<AccountPort["disableFailedAccount"]>(() => Effect.succeed(0)),
  };
}

function health(): Stub<HealthPort> {
  return {
    bumpRequests: mock<HealthPort["bumpRequests"]>(() => Effect.succeed(undefined)),
    healthState: mock<HealthPort["healthState"]>(absent),
    markFailed: mock<HealthPort["markFailed"]>(() => Effect.succeed(undefined)),
    setAccountCooldown: mock<HealthPort["setAccountCooldown"]>(() => Effect.succeed(undefined)),
    setAccountActive: mock<HealthPort["setAccountActive"]>(() => Effect.succeed(undefined)),
    markLimited: mock<HealthPort["markLimited"]>(() => Effect.succeed(undefined)),
    recordRequestError: mock<HealthPort["recordRequestError"]>(() => Effect.succeed(undefined)),
    markAccountSuccess: mock<HealthPort["markAccountSuccess"]>(() => Effect.succeed(undefined)),
    markRecovered: mock<HealthPort["markRecovered"]>(() => Effect.succeed(undefined)),
    healthByAccount: mock<HealthPort["healthByAccount"]>(() => Effect.succeed([])),
    getModelHealth: mock<HealthPort["getModelHealth"]>(absent),
    bumpCounters: mock<HealthPort["bumpCounters"]>(() => Effect.succeed(undefined)),
    setStatus: mock<HealthPort["setStatus"]>(() => Effect.succeed(undefined)),
    insertModelHealth: mock<HealthPort["insertModelHealth"]>(() => Effect.succeed(undefined)),
    markUsageLimited: mock<HealthPort["markUsageLimited"]>(() => Effect.succeed(undefined)),
    markSuccess: mock<HealthPort["markSuccess"]>(() => Effect.succeed(undefined)),
    successStatus: mock<HealthPort["successStatus"]>(() => Effect.succeed(undefined)),
    recordFailure: mock<HealthPort["recordFailure"]>(() => Effect.succeed(undefined)),
    failStatus: mock<HealthPort["failStatus"]>(() => Effect.succeed(undefined)),
  };
}

function customProviders(): Stub<CustomPort> {
  return {
    listCustomProviders: mock<CustomPort["listCustomProviders"]>(() => Effect.succeed([])),
    getCustomProvider: mock<CustomPort["getCustomProvider"]>(absent),
    customModels: mock<CustomPort["customModels"]>(() => Effect.succeed([])),
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
    debitAllowNegative: mock<PointPort["debitAllowNegative"]>(() => Effect.succeed(10)),
    insertBalance: mock<PointPort["insertBalance"]>(() => Effect.succeed(0)),
    insertPointTransaction: mock<PointPort["insertPointTransaction"]>(() => Effect.succeed(undefined)),
    insertTransaction: mock<PointPort["insertTransaction"]>(() => Effect.succeed(0)),
    updateTransactionBalance: mock<PointPort["updateTransactionBalance"]>(() => Effect.succeed(undefined)),
    listOrphaned: mock<PointPort["listOrphaned"]>(() => Effect.succeed([])),
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
