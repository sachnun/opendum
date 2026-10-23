import type { DbExecutor } from "../client.js";
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

  transaction<T>(run: (points: Points) => Promise<T>): Promise<T> {
    return this.database.transaction(async (tx) => run(new Points(tx)));
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
