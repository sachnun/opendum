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
import { patchQueryValue, refreshQueries, setQueryValue } from "../utils/atom";
import { injectRegistry } from "@effect/atom-vue";

type ShellAccountSummary = {
  accountCounts: Record<string, number>;
  activeAccountCounts: Record<string, number>;
  accountIndicators: Record<string, "normal" | "warning" | "error">;
  pinnedProviders: string[];
  hasConnectedAccounts: boolean;
};

type ApiKeyPageData = {
  apiKeys: ApiKeyListItem[];
  options: ApiKeyOptions;
};

function replacePinnedProvider(providers: string[], provider: string, pinned: boolean): string[] {
  const nextProviders = providers.filter((item) => item !== provider);
  return pinned ? [...nextProviders, provider] : nextProviders;
}

export function useInvalidate() {
  const registry = injectRegistry();

  function patchProviderAccount(provider: string, accountId: string, patch: Partial<ProviderAccountDetailItem>) {
    patchQueryValue<ProviderDetailData>(registry, dataKeys.accountsDetail(provider), (value) => ({
      ...value,
      accounts: value.accounts.map((account) => (account.id === accountId ? { ...account, ...patch } : account)),
    }));
  }

  function removeProviderAccount(provider: string, accountId: string) {
    patchQueryValue<ProviderDetailData>(registry, dataKeys.accountsDetail(provider), (value) => ({
      ...value,
      accounts: value.accounts.filter((account) => account.id !== accountId),
      supportedModelsByAccountId: Object.fromEntries(Object.entries(value.supportedModelsByAccountId).filter(([id]) => id !== accountId)),
      disabledModelsByAccountId: Object.fromEntries(Object.entries(value.disabledModelsByAccountId).filter(([id]) => id !== accountId)),
      modelHealthByAccountId: Object.fromEntries(Object.entries(value.modelHealthByAccountId).filter(([id]) => id !== accountId)),
    }));
  }

  function patchAccountNameInOptions(accountId: string, name: string) {
    patchQueryValue<ApiKeyPageData>(registry, dataKeys.apiKeys, (value) => ({
      ...value,
      options: {
        ...value.options,
        providerAccounts: value.options.providerAccounts.map((account) => (account.id === accountId ? { ...account, name } : account)),
      },
    }));

    patchQueryValue<PlaygroundOptions>(registry, dataKeys.playgroundOptions, (value) => ({
      ...value,
      providerAccounts: value.providerAccounts.map((account) => (account.id === accountId ? { ...account, name } : account)),
    }));
  }

  function patchDisabledModels(provider: string, accountId: string, disabledModels: string[]) {
    patchQueryValue<ProviderDetailData>(registry, dataKeys.accountsDetail(provider), (value) => ({
      ...value,
      disabledModelsByAccountId: {
        ...value.disabledModelsByAccountId,
        [accountId]: disabledModels,
      },
    }));

    patchQueryValue<PlaygroundOptions>(registry, dataKeys.playgroundOptions, (value) => ({
      ...value,
      providerAccounts: value.providerAccounts.map((account) => (account.id === accountId ? { ...account, disabledModels } : account)),
    }));
  }

  function patchApiKey(apiKeyId: string, patch: Partial<ApiKeyListItem>) {
    patchQueryValue<ApiKeyPageData>(registry, dataKeys.apiKeys, (value) => ({
      ...value,
      apiKeys: value.apiKeys.map((apiKey) => (apiKey.id === apiKeyId ? { ...apiKey, ...patch } : apiKey)),
    }));
  }

  function patchApiKeyRoamingPoints(roamingPointsByApiKeyId: Record<string, number>) {
    patchQueryValue<ApiKeyPageData>(registry, dataKeys.apiKeys, (value) => ({
      ...value,
      apiKeys: value.apiKeys.map((apiKey) => (Object.prototype.hasOwnProperty.call(roamingPointsByApiKeyId, apiKey.id)
        ? { ...apiKey, roamingPointsUsed: roamingPointsByApiKeyId[apiKey.id] ?? 0 }
        : apiKey)),
    }));
  }

  function removeApiKey(apiKeyId: string) {
    patchQueryValue<ApiKeyPageData>(registry, dataKeys.apiKeys, (value) => {
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
    patchQueryValue<ModelListItem[]>(registry, dataKeys.models, (value) => value.map((model) => (model.id === modelId ? { ...model, isEnabled: enabled } : model)));
    patchQueryValue<ModelSearchItem[]>(registry, dataKeys.modelSearch, (value) => value.map((model) => (model.id === modelId ? { ...model, isEnabled: enabled } : model)));
  }

  function invalidateAccountCollection(provider: string) {
    return refreshQueries(registry, [
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
    return refreshQueries(registry, [dataKeys.shellAccounts, dataKeys.accountsOverview]);
  }

  function clearAccountDependentOptions() {
    return refreshQueries(registry, [dataKeys.playgroundOptions, dataKeys.apiKeys]);
  }

  function invalidateModelAvailability() {
    return refreshQueries(registry, [
      dataKeys.modelSearch,
      dataKeys.shellModelFamilyCounts,
      dataKeys.playgroundOptions,
      dataKeys.apiKeys,
    ]);
  }

  function clearModelAvailability() {
    return refreshQueries(registry, [dataKeys.models, dataKeys.modelSearch, dataKeys.shellModelFamilyCounts]);
  }

  function patchPinnedProvider(provider: string, pinned: boolean) {
    patchQueryValue<ShellAccountSummary>(registry, dataKeys.shellAccounts, (value) => ({
      ...value,
      pinnedProviders: replacePinnedProvider(value.pinnedProviders, provider, pinned),
    }));

    patchQueryValue<AccountOverviewData>(registry, dataKeys.accountsOverview, (value) => ({
      ...value,
      pinnedProviders: replacePinnedProvider(value.pinnedProviders, provider, pinned),
    }));

    patchQueryValue<ProviderDetailData>(registry, dataKeys.accountsDetail(provider), (value) => ({
      ...value,
      pinnedProviders: replacePinnedProvider(value.pinnedProviders, provider, pinned),
    }));
  }

  function refreshData(keys: string | string[]) {
    return refreshQueries(registry, keys);
  }

  function setValue<T>(key: string, value: T) {
    setQueryValue(registry, key, value);
  }

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
    setQueryValue: setValue,
  };
}
