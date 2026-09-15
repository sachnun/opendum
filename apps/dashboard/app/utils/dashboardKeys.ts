export const dashboardDataKeys = {
  dashboardMe: "dashboard-me",
  shellAccounts: "dashboard-shell-accounts",
  accountsOverview: "dashboard-accounts-overview",
  accountsDetail: (provider: string) => `dashboard-accounts-detail-${provider}`,
  models: "dashboard-models",
  shellModelFamilyCounts: "dashboard-shell-model-family-counts",
  modelSearch: "layout-model-search",
  playgroundOptions: "dashboard-playground-options",
  apiKeys: "dashboard-api-keys",
} as const;

export const dashboardStateKeys = {
  modelFamilyCountsOverride: "dashboard-model-family-counts-override",
  pinnedProviders: "dashboard-shell-pinned-providers",
  me: "dashboard-me-state",
  auditRefreshVersion: "dashboard-audit-refresh-version",
  quotaByAccountId: "account-quota-by-account-id",
  quotaErrorByAccountId: "account-quota-error-by-account-id",
  quotaLoadingByAccountId: "account-quota-loading-by-account-id",
  quotaHydratedAccountIds: "account-quota-hydrated-account-ids",
} as const;
