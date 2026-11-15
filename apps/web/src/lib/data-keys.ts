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
