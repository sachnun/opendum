import type { DbExecutor } from "../client.js";
import {
  bumpAccountRequestCount,
  getAccountHealthState,
  getModelHealth,
  insertModelHealth,
  listModelHealthByAccount,
  markAccountRecoveredByRotation,
  markAccountSuccess,
  markUsageLimitedHealth,
  recordRequestError,
  setAccountActive,
  setAccountCooldown,
  setAccountHealthFailed,
  setAccountUsageLimited,
  updateModelHealthCounters,
  updateModelHealthFailure,
  updateModelHealthFailureWithStatus,
  updateModelHealthStatus,
  updateModelHealthSuccess,
  updateModelHealthSuccessWithStatus,
} from "../queries/index.js";

export class Health {
  constructor(private readonly database: DbExecutor) {}

  bumpAccountRequestCount(params: Parameters<typeof bumpAccountRequestCount>[0]) {
    return bumpAccountRequestCount(params, this.database);
  }

  getAccountHealthState(id: string) {
    return getAccountHealthState(id, this.database);
  }

  setAccountHealthFailed(params: Parameters<typeof setAccountHealthFailed>[0]) {
    return setAccountHealthFailed(params, this.database);
  }

  setAccountCooldown(params: Parameters<typeof setAccountCooldown>[0]) {
    return setAccountCooldown(params, this.database);
  }

  setAccountActive(params: Parameters<typeof setAccountActive>[0]) {
    return setAccountActive(params, this.database);
  }

  setAccountUsageLimited(params: Parameters<typeof setAccountUsageLimited>[0]) {
    return setAccountUsageLimited(params, this.database);
  }

  recordRequestError(params: Parameters<typeof recordRequestError>[0]) {
    return recordRequestError(params, this.database);
  }

  markAccountSuccess(params: Parameters<typeof markAccountSuccess>[0]) {
    return markAccountSuccess(params, this.database);
  }

  markAccountRecoveredByRotation(params: Parameters<typeof markAccountRecoveredByRotation>[0]) {
    return markAccountRecoveredByRotation(params, this.database);
  }

  listModelHealthByAccount(accountId: string) {
    return listModelHealthByAccount(accountId, this.database);
  }

  getModelHealth(accountId: string, model: string) {
    return getModelHealth(accountId, model, this.database);
  }

  updateModelHealthCounters(params: Parameters<typeof updateModelHealthCounters>[0]) {
    return updateModelHealthCounters(params, this.database);
  }

  updateModelHealthStatus(params: Parameters<typeof updateModelHealthStatus>[0]) {
    return updateModelHealthStatus(params, this.database);
  }

  insertModelHealth(params: Parameters<typeof insertModelHealth>[0]) {
    return insertModelHealth(params, this.database);
  }

  markUsageLimitedHealth(params: Parameters<typeof markUsageLimitedHealth>[0]) {
    return markUsageLimitedHealth(params, this.database);
  }

  updateModelHealthSuccess(params: Parameters<typeof updateModelHealthSuccess>[0]) {
    return updateModelHealthSuccess(params, this.database);
  }

  updateModelHealthSuccessWithStatus(params: Parameters<typeof updateModelHealthSuccessWithStatus>[0]) {
    return updateModelHealthSuccessWithStatus(params, this.database);
  }

  updateModelHealthFailure(params: Parameters<typeof updateModelHealthFailure>[0]) {
    return updateModelHealthFailure(params, this.database);
  }

  updateModelHealthFailureWithStatus(params: Parameters<typeof updateModelHealthFailureWithStatus>[0]) {
    return updateModelHealthFailureWithStatus(params, this.database);
  }
}
