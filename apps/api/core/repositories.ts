import type { Database } from "@opendum/database";
import {
  Accounts,
  Customs,
  Health,
  Points,
  Usage,
} from "@opendum/database/repositories";

/**
 * Structural ports for the proxy's database collaborators. `Pick` keeps only
 * the public repository surface (no private state), so both the real
 * repositories and test doubles satisfy them.
 */
export type AccountPort = Pick<Accounts, keyof Accounts>;
export type HealthPort = Pick<Health, keyof Health>;
export type CustomPort = Pick<Customs, keyof Customs>;
export type UsagePort = Pick<Usage, keyof Usage>;

/**
 * The point repository's `transaction` hands out a repository bound to the
 * transaction, so the port re-declares it against itself instead of the class.
 */
export type PointPort = Omit<Pick<Points, keyof Points>, "transaction"> & {
  transaction<T>(run: (points: PointPort) => Promise<T>): Promise<T>;
};

/** Database ports consumed by the proxy service and its collaborators. */
export type Repositories = {
  accounts: AccountPort;
  health: HealthPort;
  customProviders: CustomPort;
  usage: UsagePort;
  points: PointPort;
};

export function repositories(database: Database): Repositories {
  return {
    accounts: new Accounts(database),
    health: new Health(database),
    customProviders: new Customs(database),
    usage: new Usage(database),
    points: new Points(database),
  };
}
