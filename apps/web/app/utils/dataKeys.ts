export const dataKeys = {
  me: "web-me",
  shellAccounts: "web-shell-accounts",
  accountsOverview: "web-accounts-overview",
  accountsDetail: (provider: string) => `web-accounts-detail-${provider}`,
  models: "web-models",
  shellModelFamilyCounts: "web-shell-model-family-counts",
  modelSearch: "layout-model-search",
  modelCatalog: "web-model-catalog",
  playgroundOptions: "web-playground-options",
  apiKeys: "web-api-keys",
  customProviders: "web-custom-providers",
} as const;

export const stateKeys = {
  pinnedProviders: "web-shell-pinned-providers",
  me: "web-me-state",
  auditRefreshVersion: "web-audit-refresh-version",
  quotaByAccountId: "account-quota-by-account-id",
  quotaErrorByAccountId: "account-quota-error-by-account-id",
  quotaLoadingByAccountId: "account-quota-loading-by-account-id",
  quotaHydratedAccountIds: "account-quota-hydrated-account-ids",
} as const;
