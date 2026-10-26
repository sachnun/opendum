import type {
  AccountOverviewData,
  KeyListItem,
  ApiKeyOptions,
  ModelListItem,
  ModelSearchItem,
  PlaygroundOptions,
  AccountDetailItem,
  ProviderDetailData,
} from "../../lib/api-types";

type ShellAccountSummary = {
  accountCounts: Record<string, number>;
  activeAccountCounts: Record<string, number>;
  accountIndicators: Record<string, "normal" | "warning" | "error">;
  pinnedProviders: string[];
  hasConnectedAccounts: boolean;
};

type PageData = {
  apiKeys: KeyListItem[];
  options: ApiKeyOptions;
};

function patchNuxtData<T>(key: string, patcher: (value: T) => T) {
  const { data } = useNuxtData<T>(key);
  if (!data.value) return;

  data.value = patcher(data.value);
}

function refreshData(keys: string | string[]) {
  return refreshNuxtData(keys);
}

function clearData(keys: string | string[]) {
  clearNuxtData(keys);
}

function replacePinnedProvider(providers: string[], provider: string, pinned: boolean): string[] {
  const nextProviders = providers.filter((item) => item !== provider);
  return pinned ? [...nextProviders, provider] : nextProviders;
}

function patchProviderAccount(provider: string, accountId: string, patch: Partial<AccountDetailItem>) {
  patchNuxtData<ProviderDetailData>(dataKeys.accountsDetail(provider), (value) => ({
    ...value,
    accounts: value.accounts.map((account) => (account.id === accountId ? { ...account, ...patch } : account)),
  }));
}

function removeProviderAccount(provider: string, accountId: string) {
  patchNuxtData<ProviderDetailData>(dataKeys.accountsDetail(provider), (value) => ({
    ...value,
    accounts: value.accounts.filter((account) => account.id !== accountId),
    supportedByAccount: Object.fromEntries(Object.entries(value.supportedByAccount).filter(([id]) => id !== accountId)),
    disabledModelsByAccountId: Object.fromEntries(Object.entries(value.disabledModelsByAccountId).filter(([id]) => id !== accountId)),
    modelHealthByAccountId: Object.fromEntries(Object.entries(value.modelHealthByAccountId).filter(([id]) => id !== accountId)),
  }));
}

function patchName(accountId: string, name: string) {
  patchNuxtData<PageData>(dataKeys.apiKeys, (value) => ({
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

function patchApiKey(apiKeyId: string, patch: Partial<KeyListItem>) {
  patchNuxtData<PageData>(dataKeys.apiKeys, (value) => ({
    ...value,
    apiKeys: value.apiKeys.map((apiKey) => (apiKey.id === apiKeyId ? { ...apiKey, ...patch } : apiKey)),
  }));
}

function patchRoaming(roamingByKey: Record<string, number>) {
  patchNuxtData<PageData>(dataKeys.apiKeys, (value) => ({
    ...value,
    apiKeys: value.apiKeys.map((apiKey) => (Object.prototype.hasOwnProperty.call(roamingByKey, apiKey.id)
      ? { ...apiKey, roamingPointsUsed: roamingByKey[apiKey.id] ?? 0 }
      : apiKey)),
  }));
}

function removeApiKey(apiKeyId: string) {
  patchNuxtData<PageData>(dataKeys.apiKeys, (value) => {
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

function patchModels(list: ModelListItem[]) {
  patchNuxtData<ModelListItem[]>(dataKeys.models, () => list);
  patchNuxtData<ModelSearchItem[]>(dataKeys.modelSearch, () => list.map(({ id, providers, reasoning, modalities, cost, isEnabled, available, custom }) => ({ id, providers, reasoning, modalities, cost, isEnabled, available, custom })));
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

function clearOptions() {
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

function patchPinnedProvider(provider: string, pinned: boolean) {
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
    clearOptions,
    invalidateAccountCollection,
    invalidateAccountOverview,
    invalidateModelAvailability,
    clearModelAvailability,
    patchName,
    patchApiKey,
    patchRoaming,
    patchDisabledModels,
    patchModelEnabled,
    patchModels,
    patchPinnedProvider,
    patchProviderAccount,
    refreshData,
    removeApiKey,
    removeProviderAccount,
  };
}
