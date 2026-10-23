import { Effect } from "effect";
import type { DbExecutor } from "../client.js";
import { DatabaseFailure, databaseFailure } from "../errors.js";
import {
  creditPointBalance,
  debitPointBalance,
  debitPointBalanceAllowNegative,
  insertPointBalanceOnConflictDoNothing,
  listOrphanedRoamingDebits,
  insertPointTransaction,
  insertPointTransactionOnConflictDoNothing,
  updatePointTransactionBalance,
} from "../queries/index.js";

export class Points {
  constructor(private readonly database: DbExecutor) {}

  transaction<A>(run: (points: Points) => Effect.Effect<A, DatabaseFailure>): Effect.Effect<A, DatabaseFailure> {
    return Effect.tryPromise({
      try: () => this.database.transaction((tx) => Effect.runPromise(run(new Points(tx)))),
      catch: (cause) => databaseFailure("transaction", cause),
    });
  }

  creditPointBalance(params: Parameters<typeof creditPointBalance>[0]) {
    return creditPointBalance(params, this.database);
  }

  debitPointBalance(params: Parameters<typeof debitPointBalance>[0]) {
    return debitPointBalance(params, this.database);
  }

  debitPointBalanceAllowNegative(params: Parameters<typeof debitPointBalanceAllowNegative>[0]) {
    return debitPointBalanceAllowNegative(params, this.database);
  }

  insertPointBalanceOnConflictDoNothing(params: Parameters<typeof insertPointBalanceOnConflictDoNothing>[0]) {
    return insertPointBalanceOnConflictDoNothing(params, this.database);
  }

  insertPointTransaction(params: Parameters<typeof insertPointTransaction>[0]) {
    return insertPointTransaction(params, this.database);
  }

  insertPointTransactionOnConflictDoNothing(params: Parameters<typeof insertPointTransactionOnConflictDoNothing>[0]) {
    return insertPointTransactionOnConflictDoNothing(params, this.database);
  }

  updatePointTransactionBalance(params: Parameters<typeof updatePointTransactionBalance>[0]) {
    return updatePointTransactionBalance(params, this.database);
  }

  listOrphanedRoamingDebits(params: Parameters<typeof listOrphanedRoamingDebits>[0]) {
    return listOrphanedRoamingDebits(params, this.database);
  }
}
