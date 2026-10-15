import type { Database } from "@opendum/database";
import {
  CustomProviderRepository,
  ModelHealthRepository,
  PointRepository,
  ProviderAccountRepository,
  UsageRepository,
} from "@opendum/database/repositories";

/**
 * Structural ports for the proxy's database collaborators. `Pick` keeps only
 * the public repository surface (no private state), so both the real
 * repositories and test doubles satisfy them.
 */
export type ProviderAccountPort = Pick<ProviderAccountRepository, keyof ProviderAccountRepository>;
export type ModelHealthPort = Pick<ModelHealthRepository, keyof ModelHealthRepository>;
export type CustomProviderPort = Pick<CustomProviderRepository, keyof CustomProviderRepository>;
export type UsagePort = Pick<UsageRepository, keyof UsageRepository>;

/**
 * The point repository's `transaction` hands out a repository bound to the
 * transaction, so the port re-declares it against itself instead of the class.
 */
export type PointPort = Omit<Pick<PointRepository, keyof PointRepository>, "transaction"> & {
  transaction<T>(run: (points: PointPort) => Promise<T>): Promise<T>;
};

/** Database ports consumed by the proxy service and its collaborators. */
export type ProxyRepositories = {
  accounts: ProviderAccountPort;
  health: ModelHealthPort;
  customProviders: CustomProviderPort;
  usage: UsagePort;
  points: PointPort;
};

export function createProxyRepositories(database: Database): ProxyRepositories {
  return {
    accounts: new ProviderAccountRepository(database),
    health: new ModelHealthRepository(database),
    customProviders: new CustomProviderRepository(database),
    usage: new UsageRepository(database),
    points: new PointRepository(database),
  };
}
