import type {
  AccountOverviewData,
  ApiKeyListItem,
  ApiKeyOptions,
  ModelListItem,
  ModelSearchItem,
  PlaygroundOptions,
  ProviderAccountDetailItem,
  ProviderDetailData,
} from "../../lib/dashboard-api-types";
import type { ProviderAccountKey } from "../../lib/provider-accounts";

type ShellAccountSummary = {
  accountCounts: Record<string, number>;
  activeAccountCounts: Record<string, number>;
  accountIndicators: Record<string, "normal" | "warning" | "error">;
  pinnedProviders: ProviderAccountKey[];
  hasConnectedAccounts: boolean;
};

type ApiKeyPageData = {
  apiKeys: ApiKeyListItem[];
  options: ApiKeyOptions;
};

export const dashboardDataKeys = {
  shellAccounts: "dashboard-shell-accounts",
  accountsOverview: "dashboard-accounts-overview",
  accountsDetail: (provider: string) => `dashboard-accounts-detail-${provider}`,
  models: "dashboard-models",
  shellModelFamilyCounts: "dashboard-shell-model-family-counts",
  modelSearch: "layout-model-search",
  playgroundOptions: "dashboard-playground-options",
  apiKeys: "dashboard-api-keys",
} as const;

function patchNuxtData<T>(key: string, patcher: (value: T) => T) {
  const { data } = useNuxtData<T>(key);
  if (!data.value) return;
  data.value = patcher(data.value);
}

function refreshDashboardData(keys: string | string[]) {
  return refreshNuxtData(keys);
}

function clearDashboardData(keys: string | string[]) {
  clearNuxtData(keys);
}

function replacePinnedProvider(providers: ProviderAccountKey[], provider: ProviderAccountKey, pinned: boolean): ProviderAccountKey[] {
  const nextProviders = providers.filter((item) => item !== provider);
  return pinned ? [...nextProviders, provider] : nextProviders;
}

function patchProviderAccount(provider: string, accountId: string, patch: Partial<ProviderAccountDetailItem>) {
  patchNuxtData<ProviderDetailData>(dashboardDataKeys.accountsDetail(provider), (value) => ({
    ...value,
    accounts: value.accounts.map((account) => (account.id === accountId ? { ...account, ...patch } : account)),
  }));
}

function removeProviderAccount(provider: string, accountId: string) {
  patchNuxtData<ProviderDetailData>(dashboardDataKeys.accountsDetail(provider), (value) => ({
    ...value,
    accounts: value.accounts.filter((account) => account.id !== accountId),
    disabledModelsByAccountId: Object.fromEntries(Object.entries(value.disabledModelsByAccountId).filter(([id]) => id !== accountId)),
    modelHealthByAccountId: Object.fromEntries(Object.entries(value.modelHealthByAccountId).filter(([id]) => id !== accountId)),
  }));
}

function patchAccountNameInOptions(accountId: string, name: string) {
  patchNuxtData<ApiKeyPageData>(dashboardDataKeys.apiKeys, (value) => ({
    ...value,
    options: {
      ...value.options,
      providerAccounts: value.options.providerAccounts.map((account) => (account.id === accountId ? { ...account, name } : account)),
    },
  }));

  patchNuxtData<PlaygroundOptions>(dashboardDataKeys.playgroundOptions, (value) => ({
    ...value,
    providerAccounts: value.providerAccounts.map((account) => (account.id === accountId ? { ...account, name } : account)),
  }));
}

function patchDisabledModels(provider: string, accountId: string, disabledModels: string[]) {
  patchNuxtData<ProviderDetailData>(dashboardDataKeys.accountsDetail(provider), (value) => ({
    ...value,
    disabledModelsByAccountId: {
      ...value.disabledModelsByAccountId,
      [accountId]: disabledModels,
    },
  }));

  patchNuxtData<PlaygroundOptions>(dashboardDataKeys.playgroundOptions, (value) => ({
    ...value,
    providerAccounts: value.providerAccounts.map((account) => (account.id === accountId ? { ...account, disabledModels } : account)),
  }));
}

function patchApiKey(apiKeyId: string, patch: Partial<ApiKeyListItem>) {
  patchNuxtData<ApiKeyPageData>(dashboardDataKeys.apiKeys, (value) => ({
    ...value,
    apiKeys: value.apiKeys.map((apiKey) => (apiKey.id === apiKeyId ? { ...apiKey, ...patch } : apiKey)),
  }));
}

function removeApiKey(apiKeyId: string) {
  patchNuxtData<ApiKeyPageData>(dashboardDataKeys.apiKeys, (value) => {
    const { [apiKeyId]: _removedRateLimits, ...rateLimitsByKeyId } = value.options.rateLimitsByKeyId;

    return {
      ...value,
      apiKeys: value.apiKeys.filter((apiKey) => apiKey.id !== apiKeyId),
      options: {
        ...value.options,
        rateLimitsByKeyId,
      },
    };
  });
}

function patchModelEnabled(modelId: string, enabled: boolean) {
  patchNuxtData<ModelListItem[]>(dashboardDataKeys.models, (value) => value.map((model) => (model.id === modelId ? { ...model, isEnabled: enabled } : model)));
  patchNuxtData<ModelSearchItem[]>(dashboardDataKeys.modelSearch, (value) => value.map((model) => (model.id === modelId ? { ...model, isEnabled: enabled } : model)));
}

function invalidateAccountCollection(provider: string) {
  return refreshDashboardData([
    dashboardDataKeys.shellAccounts,
    dashboardDataKeys.accountsOverview,
    dashboardDataKeys.accountsDetail(provider),
    dashboardDataKeys.models,
    dashboardDataKeys.shellModelFamilyCounts,
    dashboardDataKeys.modelSearch,
    dashboardDataKeys.playgroundOptions,
    dashboardDataKeys.apiKeys,
  ]);
}

function invalidateAccountOverview() {
  return refreshDashboardData([dashboardDataKeys.shellAccounts, dashboardDataKeys.accountsOverview]);
}

function clearAccountDependentOptions() {
  clearDashboardData([dashboardDataKeys.playgroundOptions, dashboardDataKeys.apiKeys]);
}

function invalidateModelAvailability() {
  return refreshDashboardData([
    dashboardDataKeys.modelSearch,
    dashboardDataKeys.shellModelFamilyCounts,
    dashboardDataKeys.playgroundOptions,
    dashboardDataKeys.apiKeys,
  ]);
}

function clearModelAvailability() {
  return refreshDashboardData([dashboardDataKeys.models, dashboardDataKeys.modelSearch, dashboardDataKeys.shellModelFamilyCounts]);
}

function patchPinnedProvider(provider: ProviderAccountKey, pinned: boolean) {
  patchNuxtData<ShellAccountSummary>(dashboardDataKeys.shellAccounts, (value) => ({
    ...value,
    pinnedProviders: replacePinnedProvider(value.pinnedProviders, provider, pinned),
  }));

  patchNuxtData<AccountOverviewData>(dashboardDataKeys.accountsOverview, (value) => ({
    ...value,
    pinnedProviders: replacePinnedProvider(value.pinnedProviders, provider, pinned),
  }));

  patchNuxtData<ProviderDetailData>(dashboardDataKeys.accountsDetail(provider), (value) => ({
    ...value,
    pinnedProviders: replacePinnedProvider(value.pinnedProviders, provider, pinned),
  }));
}

export function useDashboardDataInvalidation() {
  return {
    keys: dashboardDataKeys,
    clearAccountDependentOptions,
    invalidateAccountCollection,
    invalidateAccountOverview,
    invalidateModelAvailability,
    clearModelAvailability,
    patchAccountNameInOptions,
    patchApiKey,
    patchDisabledModels,
    patchModelEnabled,
    patchPinnedProvider,
    patchProviderAccount,
    refreshDashboardData,
    removeApiKey,
    removeProviderAccount,
  };
}
