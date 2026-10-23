import type { DbExecutor } from "../client.js";
import {
  disableFailedAccount,
  getAccountCredentialsByID,
  getAccountOwnerUserID,
  getForcedAccount,
  getQuotaAccount,
  listDisabledAccountIDs,
  listEligibleAccounts,
  listExpiringRefreshableAccounts,
  listSharedEligibleAccounts,
  recordAccountError,
  updateRefreshedCredentials,
} from "../queries/index.js";

export class Accounts {
  constructor(private readonly database: DbExecutor) {}

  listEligibleAccounts(params: Parameters<typeof listEligibleAccounts>[0]) {
    return listEligibleAccounts(params, this.database);
  }

  listSharedEligibleAccounts(params: Parameters<typeof listSharedEligibleAccounts>[0]) {
    return listSharedEligibleAccounts(params, this.database);
  }

  listDisabledAccountIDs(params: Parameters<typeof listDisabledAccountIDs>[0]) {
    return listDisabledAccountIDs(params, this.database);
  }

  listExpiringRefreshableAccounts(params: Parameters<typeof listExpiringRefreshableAccounts>[0]) {
    return listExpiringRefreshableAccounts(params, this.database);
  }

  getForcedAccount(id: string, userId: string) {
    return getForcedAccount(id, userId, this.database);
  }

  getQuotaAccount(id: string, userId: string, provider: string) {
    return getQuotaAccount(id, userId, provider, this.database);
  }

  getAccountCredentialsByID(id: string) {
    return getAccountCredentialsByID(id, this.database);
  }

  getAccountOwnerUserID(id: string) {
    return getAccountOwnerUserID(id, this.database);
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
