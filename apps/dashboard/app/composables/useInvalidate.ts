import type {
  AccountOverviewData,
  ApiKeyListItem,
  ApiKeyOptions,
  ModelListItem,
  ModelSearchItem,
  PlaygroundOptions,
  ProviderAccountDetailItem,
  ProviderDetailData,
} from "../../lib/api-types";
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

function patchNuxtData<T>(key: string, patcher: (value: T) => T) {
  const { data } = useNuxtData<T>(key);
  if (!data.value) return;

  const next = patcher(data.value);
  data.value = next;
  writeDataCache(key, next);
}

function refreshData(keys: string | string[]) {
  removeDataCache(keys);
  return refreshNuxtData(keys);
}

function clearData(keys: string | string[]) {
  removeDataCache(keys);
  clearNuxtData(keys);
}

function replacePinnedProvider(providers: ProviderAccountKey[], provider: ProviderAccountKey, pinned: boolean): ProviderAccountKey[] {
  const nextProviders = providers.filter((item) => item !== provider);
  return pinned ? [...nextProviders, provider] : nextProviders;
}

function patchProviderAccount(provider: string, accountId: string, patch: Partial<ProviderAccountDetailItem>) {
  patchNuxtData<ProviderDetailData>(dataKeys.accountsDetail(provider), (value) => ({
    ...value,
    accounts: value.accounts.map((account) => (account.id === accountId ? { ...account, ...patch } : account)),
  }));
}

function removeProviderAccount(provider: string, accountId: string) {
  patchNuxtData<ProviderDetailData>(dataKeys.accountsDetail(provider), (value) => ({
    ...value,
    accounts: value.accounts.filter((account) => account.id !== accountId),
    supportedModelsByAccountId: Object.fromEntries(Object.entries(value.supportedModelsByAccountId).filter(([id]) => id !== accountId)),
    disabledModelsByAccountId: Object.fromEntries(Object.entries(value.disabledModelsByAccountId).filter(([id]) => id !== accountId)),
    modelHealthByAccountId: Object.fromEntries(Object.entries(value.modelHealthByAccountId).filter(([id]) => id !== accountId)),
  }));
}

function patchAccountNameInOptions(accountId: string, name: string) {
  patchNuxtData<ApiKeyPageData>(dataKeys.apiKeys, (value) => ({
    ...value,
    options: {
      ...value.options,
      providerAccounts: value.options.providerAccounts.map((account) => (account.id === accountId ? { ...account, name } : account)),
    },
  }));

  patchNuxtData<PlaygroundOptions>(dataKeys.playgroundOptions, (value) => ({
    ...value,
    providerAccounts: value.providerAccounts.map((account) => (account.id === accountId ? { ...account, name } : account)),
  }));
}

function patchDisabledModels(provider: string, accountId: string, disabledModels: string[]) {
  patchNuxtData<ProviderDetailData>(dataKeys.accountsDetail(provider), (value) => ({
    ...value,
    disabledModelsByAccountId: {
      ...value.disabledModelsByAccountId,
      [accountId]: disabledModels,
    },
  }));

  patchNuxtData<PlaygroundOptions>(dataKeys.playgroundOptions, (value) => ({
    ...value,
    providerAccounts: value.providerAccounts.map((account) => (account.id === accountId ? { ...account, disabledModels } : account)),
  }));
}

function patchApiKey(apiKeyId: string, patch: Partial<ApiKeyListItem>) {
  patchNuxtData<ApiKeyPageData>(dataKeys.apiKeys, (value) => ({
    ...value,
    apiKeys: value.apiKeys.map((apiKey) => (apiKey.id === apiKeyId ? { ...apiKey, ...patch } : apiKey)),
  }));
}

function patchApiKeyRoamingPoints(roamingPointsByApiKeyId: Record<string, number>) {
  patchNuxtData<ApiKeyPageData>(dataKeys.apiKeys, (value) => ({
    ...value,
    apiKeys: value.apiKeys.map((apiKey) => (Object.prototype.hasOwnProperty.call(roamingPointsByApiKeyId, apiKey.id)
      ? { ...apiKey, roamingPointsUsed: roamingPointsByApiKeyId[apiKey.id] ?? 0 }
      : apiKey)),
  }));
}

function removeApiKey(apiKeyId: string) {
  patchNuxtData<ApiKeyPageData>(dataKeys.apiKeys, (value) => {
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
  patchNuxtData<ModelListItem[]>(dataKeys.models, (value) => value.map((model) => (model.id === modelId ? { ...model, isEnabled: enabled } : model)));
  patchNuxtData<ModelSearchItem[]>(dataKeys.modelSearch, (value) => value.map((model) => (model.id === modelId ? { ...model, isEnabled: enabled } : model)));
}

function invalidateAccountCollection(provider: string) {
  return refreshData([
    dataKeys.shellAccounts,
    dataKeys.accountsOverview,
    dataKeys.accountsDetail(provider),
    dataKeys.models,
    dataKeys.shellModelFamilyCounts,
    dataKeys.modelSearch,
    dataKeys.playgroundOptions,
    dataKeys.apiKeys,
  ]);
}

function invalidateAccountOverview() {
  return refreshData([dataKeys.shellAccounts, dataKeys.accountsOverview]);
}

function clearAccountDependentOptions() {
  clearData([dataKeys.playgroundOptions, dataKeys.apiKeys]);
}

function invalidateModelAvailability() {
  return refreshData([
    dataKeys.modelSearch,
    dataKeys.shellModelFamilyCounts,
    dataKeys.playgroundOptions,
    dataKeys.apiKeys,
  ]);
}

function clearModelAvailability() {
  return refreshData([dataKeys.models, dataKeys.modelSearch, dataKeys.shellModelFamilyCounts]);
}

function patchPinnedProvider(provider: ProviderAccountKey, pinned: boolean) {
  patchNuxtData<ShellAccountSummary>(dataKeys.shellAccounts, (value) => ({
    ...value,
    pinnedProviders: replacePinnedProvider(value.pinnedProviders, provider, pinned),
  }));

  patchNuxtData<AccountOverviewData>(dataKeys.accountsOverview, (value) => ({
    ...value,
    pinnedProviders: replacePinnedProvider(value.pinnedProviders, provider, pinned),
  }));

  patchNuxtData<ProviderDetailData>(dataKeys.accountsDetail(provider), (value) => ({
    ...value,
    pinnedProviders: replacePinnedProvider(value.pinnedProviders, provider, pinned),
  }));
}

export function useInvalidate() {
  return {
    clearAccountDependentOptions,
    invalidateAccountCollection,
    invalidateAccountOverview,
    invalidateModelAvailability,
    clearModelAvailability,
    patchAccountNameInOptions,
    patchApiKey,
    patchApiKeyRoamingPoints,
    patchDisabledModels,
    patchModelEnabled,
    patchPinnedProvider,
    patchProviderAccount,
    refreshData,
    removeApiKey,
    removeProviderAccount,
  };
}
