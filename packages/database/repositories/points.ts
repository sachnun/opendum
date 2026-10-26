import { Effect } from "effect";
import type { DbExecutor } from "../client.js";
import { DatabaseFailure, databaseFailure } from "../errors.js";
import {
  creditPointBalance,
  debitPointBalance,
  debitAllowNegative,
  insertBalance,
  listOrphaned,
  insertPointTransaction,
  insertTransaction,
  updateTransactionBalance,
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

  debitAllowNegative(params: Parameters<typeof debitAllowNegative>[0]) {
    return debitAllowNegative(params, this.database);
  }

  insertBalance(params: Parameters<typeof insertBalance>[0]) {
    return insertBalance(params, this.database);
  }

  insertPointTransaction(params: Parameters<typeof insertPointTransaction>[0]) {
    return insertPointTransaction(params, this.database);
  }

  insertTransaction(params: Parameters<typeof insertTransaction>[0]) {
    return insertTransaction(params, this.database);
  }

  updateTransactionBalance(params: Parameters<typeof updateTransactionBalance>[0]) {
    return updateTransactionBalance(params, this.database);
  }

  listOrphaned(params: Parameters<typeof listOrphaned>[0]) {
    return listOrphaned(params, this.database);
  }
}
