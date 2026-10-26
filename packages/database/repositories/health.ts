import type { DbExecutor } from "../client.js";
import {
  bumpRequests,
  healthState,
  getModelHealth,
  insertModelHealth,
  healthByAccount,
  markRecovered,
  markAccountSuccess,
  markUsageLimited,
  recordRequestError,
  setAccountActive,
  setAccountCooldown,
  markFailed,
  markLimited,
  bumpCounters,
  recordFailure,
  failStatus,
  setStatus,
  markSuccess,
  successStatus,
} from "../queries/index.js";

export class Health {
  constructor(private readonly database: DbExecutor) {}

  bumpRequests(params: Parameters<typeof bumpRequests>[0]) {
    return bumpRequests(params, this.database);
  }

  healthState(id: string) {
    return healthState(id, this.database);
  }

  markFailed(params: Parameters<typeof markFailed>[0]) {
    return markFailed(params, this.database);
  }

  setAccountCooldown(params: Parameters<typeof setAccountCooldown>[0]) {
    return setAccountCooldown(params, this.database);
  }

  setAccountActive(params: Parameters<typeof setAccountActive>[0]) {
    return setAccountActive(params, this.database);
  }

  markLimited(params: Parameters<typeof markLimited>[0]) {
    return markLimited(params, this.database);
  }

  recordRequestError(params: Parameters<typeof recordRequestError>[0]) {
    return recordRequestError(params, this.database);
  }

  markAccountSuccess(params: Parameters<typeof markAccountSuccess>[0]) {
    return markAccountSuccess(params, this.database);
  }

  markRecovered(params: Parameters<typeof markRecovered>[0]) {
    return markRecovered(params, this.database);
  }

  healthByAccount(accountId: string) {
    return healthByAccount(accountId, this.database);
  }

  getModelHealth(accountId: string, model: string) {
    return getModelHealth(accountId, model, this.database);
  }

  bumpCounters(params: Parameters<typeof bumpCounters>[0]) {
    return bumpCounters(params, this.database);
  }

  setStatus(params: Parameters<typeof setStatus>[0]) {
    return setStatus(params, this.database);
  }

  insertModelHealth(params: Parameters<typeof insertModelHealth>[0]) {
    return insertModelHealth(params, this.database);
  }

  markUsageLimited(params: Parameters<typeof markUsageLimited>[0]) {
    return markUsageLimited(params, this.database);
  }

  markSuccess(params: Parameters<typeof markSuccess>[0]) {
    return markSuccess(params, this.database);
  }

  successStatus(params: Parameters<typeof successStatus>[0]) {
    return successStatus(params, this.database);
  }

  recordFailure(params: Parameters<typeof recordFailure>[0]) {
    return recordFailure(params, this.database);
  }

  failStatus(params: Parameters<typeof failStatus>[0]) {
    return failStatus(params, this.database);
  }
}
