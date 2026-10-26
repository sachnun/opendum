import type { DbExecutor } from "@opendum/database/client";
import {
  disableFailedAccount,
  credentialsById,
  ownerId,
  getForcedAccount,
  getQuotaAccount,
  disabledIds,
  listEligibleAccounts,
  expiringAccounts,
  sharedAccounts,
  recordAccountError,
  updateRefreshedCredentials,
} from "@opendum/database/queries/index";

export class Accounts {
  constructor(private readonly database: DbExecutor) {}

  listEligibleAccounts(params: Parameters<typeof listEligibleAccounts>[0]) {
    return listEligibleAccounts(params, this.database);
  }

  sharedAccounts(params: Parameters<typeof sharedAccounts>[0]) {
    return sharedAccounts(params, this.database);
  }

  disabledIds(params: Parameters<typeof disabledIds>[0]) {
    return disabledIds(params, this.database);
  }

  expiringAccounts(params: Parameters<typeof expiringAccounts>[0]) {
    return expiringAccounts(params, this.database);
  }

  getForcedAccount(id: string, userId: string) {
    return getForcedAccount(id, userId, this.database);
  }

  getQuotaAccount(id: string, userId: string, provider: string) {
    return getQuotaAccount(id, userId, provider, this.database);
  }

  credentialsById(id: string) {
    return credentialsById(id, this.database);
  }

  ownerId(id: string) {
    return ownerId(id, this.database);
  }

  updateRefreshedCredentials(params: Parameters<typeof updateRefreshedCredentials>[0]) {
    return updateRefreshedCredentials(params, this.database);
  }

  recordAccountError(params: Parameters<typeof recordAccountError>[0]) {
    return recordAccountError(params, this.database);
  }

  disableFailedAccount(params: Parameters<typeof disableFailedAccount>[0]) {
    return disableFailedAccount(params, this.database);
  }
}
