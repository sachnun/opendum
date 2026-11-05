import type {
  AccountOverviewData,
  KeyListItem,
  ApiKeyOptions,
  ModelListItem,
  ModelSearchItem,
  PlaygroundOptions,
  AccountDetailItem,
  ProviderDetailData,
} from "~/lib/api-types";
import { clearQueries, patchQuery, refreshQueries } from "~/lib/query";
import { dataKeys } from "~/lib/data-keys";

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

function patchQueryData<T>(key: string, patcher: (value: T) => T) {
  patchQuery(key, patcher);
}

function refreshData(keys: string | string[]) {
  return refreshQueries(keys);
}

function clearData(keys: string | string[]) {
  clearQueries(keys);
}

function replacePinnedProvider(providers: string[], provider: string, pinned: boolean): string[] {
  const nextProviders = providers.filter((item) => item !== provider);
  return pinned ? [...nextProviders, provider] : nextProviders;
}

function patchProviderAccount(provider: string, accountId: string, patch: Partial<AccountDetailItem>) {
  patchQueryData<ProviderDetailData>(dataKeys.accountsDetail(provider), (value) => ({
    ...value,
    accounts: value.accounts.map((account) => (account.id === accountId ? { ...account, ...patch } : account)),
  }));
}

function removeProviderAccount(provider: string, accountId: string) {
  patchQueryData<ProviderDetailData>(dataKeys.accountsDetail(provider), (value) => ({
    ...value,
    accounts: value.accounts.filter((account) => account.id !== accountId),
    supportedByAccount: Object.fromEntries(Object.entries(value.supportedByAccount).filter(([id]) => id !== accountId)),
    disabledModelsByAccountId: Object.fromEntries(Object.entries(value.disabledModelsByAccountId).filter(([id]) => id !== accountId)),
    modelHealthByAccountId: Object.fromEntries(Object.entries(value.modelHealthByAccountId).filter(([id]) => id !== accountId)),
  }));
}

function patchName(accountId: string, name: string) {
  patchQueryData<PageData>(dataKeys.apiKeys, (value) => ({
    ...value,
    options: {
      ...value.options,
      providerAccounts: value.options.providerAccounts.map((account) => (account.id === accountId ? { ...account, name } : account)),
    },
  }));

  patchQueryData<PlaygroundOptions>(dataKeys.playgroundOptions, (value) => ({
    ...value,
    providerAccounts: value.providerAccounts.map((account) => (account.id === accountId ? { ...account, name } : account)),
  }));
}

function patchDisabledModels(provider: string, accountId: string, disabledModels: string[]) {
  patchQueryData<ProviderDetailData>(dataKeys.accountsDetail(provider), (value) => ({
    ...value,
    disabledModelsByAccountId: {
      ...value.disabledModelsByAccountId,
      [accountId]: disabledModels,
    },
  }));

  patchQueryData<PlaygroundOptions>(dataKeys.playgroundOptions, (value) => ({
    ...value,
    providerAccounts: value.providerAccounts.map((account) => (account.id === accountId ? { ...account, disabledModels } : account)),
  }));
}

function patchApiKey(apiKeyId: string, patch: Partial<KeyListItem>) {
  patchQueryData<PageData>(dataKeys.apiKeys, (value) => ({
    ...value,
    apiKeys: value.apiKeys.map((apiKey) => (apiKey.id === apiKeyId ? { ...apiKey, ...patch } : apiKey)),
  }));
}

function patchRoaming(roamingByKey: Record<string, number>) {
  patchQueryData<PageData>(dataKeys.apiKeys, (value) => ({
    ...value,
    apiKeys: value.apiKeys.map((apiKey) => (Object.prototype.hasOwnProperty.call(roamingByKey, apiKey.id)
      ? { ...apiKey, roamingPointsUsed: roamingByKey[apiKey.id] ?? 0 }
      : apiKey)),
  }));
}

function removeApiKey(apiKeyId: string) {
  patchQueryData<PageData>(dataKeys.apiKeys, (value) => {
    const { [apiKeyId]: _removedRateLimits, ...remainingRateLimits } = value.options.rateLimitsByKeyId;

    return {
      ...value,
      apiKeys: value.apiKeys.filter((apiKey) => apiKey.id !== apiKeyId),
      options: {
        ...value.options,
        rateLimitsByKeyId: remainingRateLimits,
      },
    };
  });
}

function patchModelEnabled(modelId: string, enabled: boolean) {
  patchQueryData<ModelListItem[]>(dataKeys.models, (value) => value.map((model) => (model.id === modelId ? { ...model, isEnabled: enabled } : model)));
  patchQueryData<ModelSearchItem[]>(dataKeys.modelSearch, (value) => value.map((model) => (model.id === modelId ? { ...model, isEnabled: enabled } : model)));
}

function patchModels(list: ModelListItem[]) {
  patchQueryData<ModelListItem[]>(dataKeys.models, () => list);
  patchQueryData<ModelSearchItem[]>(dataKeys.modelSearch, () => list.map(({ id, providers, reasoning, modalities, cost, isEnabled, available, custom }) => ({ id, providers, reasoning, modalities, cost, isEnabled, available, custom })));
}

function invalidateAccountCollection(provider: string) {
  return refreshData([
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
  return refreshData([dataKeys.accountsOverview]);
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
  patchQueryData<ShellAccountSummary>(dataKeys.shellAccounts, (value) => ({
    ...value,
    pinnedProviders: replacePinnedProvider(value.pinnedProviders, provider, pinned),
  }));

  patchQueryData<AccountOverviewData>(dataKeys.accountsOverview, (value) => ({
    ...value,
    pinnedProviders: replacePinnedProvider(value.pinnedProviders, provider, pinned),
  }));

  patchQueryData<ProviderDetailData>(dataKeys.accountsDetail(provider), (value) => ({
    ...value,
    pinnedProviders: replacePinnedProvider(value.pinnedProviders, provider, pinned),
  }));
}

export const invalidation = {
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
