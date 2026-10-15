import type { Database } from "../client.js";
import {
  creditPointBalance,
  debitPointBalance,
  debitPointBalanceAllowNegative,
  insertPointBalanceOnConflictDoNothing,
  insertPointTransaction,
  insertPointTransactionOnConflictDoNothing,
  updatePointTransactionBalance,
} from "../queries/index.js";

/**
 * Point balances and transactions. Delegates to the query layer with the
 * database bound.
 */
export class PointRepository {
  constructor(private readonly database: Database) {}

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
}
