import type { Effect } from "effect";
import type { Database,DatabaseFailure } from "@opendum/database";
import {
  Accounts,
  Customs,
  Health,
  Points,
  Usage,
} from "@opendum/database/repositories";

export type AccountPort = Pick<Accounts, keyof Accounts>;
export type HealthPort = Pick<Health, keyof Health>;
export type CustomPort = Pick<Customs, keyof Customs>;
export type UsagePort = Pick<Usage, keyof Usage>;

export type PointPort = Omit<Pick<Points, keyof Points>, "transaction"> & {
  transaction<A>(
    run: (points: PointPort) => Effect.Effect<A, DatabaseFailure>
  ): Effect.Effect<A, DatabaseFailure>;
};

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
