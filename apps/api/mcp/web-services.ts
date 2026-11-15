import * as accounts from "@opendum/api/web/services/accounts";
import * as accountAuth from "@opendum/api/web/services/account-auth";
import * as accountQuota from "@opendum/api/web/services/account-quota";
import * as analytics from "@opendum/api/web/services/analytics";
import * as apiKeys from "@opendum/api/web/services/api-keys";
import * as customProviders from "@opendum/api/web/services/custom-providers";
import * as models from "@opendum/api/web/services/models";
import * as points from "@opendum/api/web/services/points";
import * as sharing from "@opendum/api/web/services/sharing";
import type { McpWebServices } from "@opendum/api/mcp/types";

export const realWebServices: McpWebServices = {
  models: {
    listModels: models.listModels,
    searchModels: models.searchModels,
    knownModels: models.knownModels,
    getModelStats: models.getModelStats,
    familyCounts: models.familyCounts,
    enableModel: models.enableModel,
  },
  analytics: {
    getAnalyticsData: analytics.getAnalyticsData,
    getAnalyticsSeries: analytics.getAnalyticsSeries,
    getAnalyticsOverview: analytics.getAnalyticsOverview,
    getUsageRows: analytics.getUsageRows,
  },
  apiKeys: {
    listApiKeys: apiKeys.listApiKeys,
    getOptions: apiKeys.getOptions,
    createApiKey: apiKeys.createApiKey,
    toggleApiKey: apiKeys.toggleApiKey,
    deleteApiKey: apiKeys.deleteApiKey,
    revealApiKey: apiKeys.revealApiKey,
    updateName: apiKeys.updateName,
    updateExpiration: apiKeys.updateExpiration,
    updateRoaming: apiKeys.updateRoaming,
    updateModels: apiKeys.updateModels,
    updateAccess: apiKeys.updateAccess,
    updateRateLimits: apiKeys.updateRateLimits,
  },
  accounts: {
    listAccounts: accounts.listAccounts,
    listByProvider: accounts.listByProvider,
    getAccountOverview: accounts.getAccountOverview,
    getAccountPing: accounts.getAccountPing,
    accountsDetailed: accounts.accountsDetailed,
    getAccountStats: accounts.getAccountStats,
    updateAccount: accounts.updateAccount,
    deleteAccount: accounts.deleteAccount,
    togglePinnedProvider: accounts.togglePinnedProvider,
    enableModel: accounts.enableModel,
    errorHistory: accounts.errorHistory,
    errorHistories: accounts.errorHistories,
    resolveAccountErrors: accounts.resolveAccountErrors,
    createAccount: accounts.createAccount,
  },
  accountQuota: {
    getAccountQuota: accountQuota.getAccountQuota,
    getAccountQuotas: accountQuota.getAccountQuotas,
  },
  accountAuth: {
    authUrlFor: accountAuth.authUrlFor,
    exchangeAccount: accountAuth.exchangeAccount,
    connectCodex: accountAuth.connectCodex,
    initiateDeviceAuth: accountAuth.initiateDeviceAuth,
    pollAuth: accountAuth.pollAuth,
  },
  customProviders: {
    listCustomProviders: customProviders.listCustomProviders,
    customProviderModels: customProviders.customProviderModels,
    createCustomProvider: customProviders.createCustomProvider,
    updateCustomProvider: customProviders.updateCustomProvider,
    deleteCustomProvider: customProviders.deleteCustomProvider,
    connectCustom: customProviders.connectCustom,
    syncCustomModels: customProviders.syncCustomModels,
    previewCustomModels: customProviders.previewCustomModels,
    upsertCustomModels: customProviders.upsertCustomModels,
    deleteCustomModel: customProviders.deleteCustomModel,
  },
  points: {
    pointStatus: points.pointStatus,
    claimDaily: points.claimDaily,
  },
  sharing: {
    sharingEnabled: sharing.sharingEnabled,
    setSharing: sharing.setSharing,
  },
};
