import { getMany, set } from "idb-keyval";
import type { ComputedRef } from "vue";
import type { AccountQuotaInfo, ProviderDetailData, QuotaProviderKey } from "../../lib/dashboard-api-types";
import { createDashboardIndexedDbStore } from "../utils/dashboardIndexedDb";

type Account = ProviderDetailData["accounts"][number];

type CachedAccountQuota = {
  accountId: string;
  provider: QuotaProviderKey;
  quota: AccountQuotaInfo;
  error?: string;
  cachedAt: number;
};

type LoadAccountQuotaOptions = {
  refreshExisting?: boolean;
  forceRefresh?: boolean;
  runId?: number;
};

type RunQuotaRefreshOptions = {
  refreshExisting?: boolean;
  forceRefresh?: boolean;
};

const QUOTA_DB_NAME = "opendum-dashboard";
const QUOTA_STORE_NAME = "account-quota";
const quotaStore = createDashboardIndexedDbStore(QUOTA_DB_NAME, QUOTA_STORE_NAME);

function getQuotaCacheKey(accountId: string) {
  return `account-quota:${accountId}`;
}

async function readCachedQuotas(accountIds: string[]) {
  if (!quotaStore || accountIds.length === 0) return [];

  try {
    return await getMany<CachedAccountQuota>(accountIds.map(getQuotaCacheKey), quotaStore);
  } catch (error) {
    console.warn("Failed to read quota cache:", error);
    return [];
  }
}

async function writeCachedQuota(account: Account, provider: QuotaProviderKey, quota: AccountQuotaInfo) {
  if (!quotaStore) return;

  try {
    await set(getQuotaCacheKey(account.id), { accountId: account.id, provider, quota, cachedAt: Date.now() } satisfies CachedAccountQuota, quotaStore);
  } catch (error) {
    console.warn("Failed to write quota cache:", error);
  }
}

export function useAccountQuotaMonitor(options: {
  accounts: ComputedRef<Account[]>;
  quotaCapableAccounts: ComputedRef<Account[]>;
  toQuotaProvider: (provider: string) => QuotaProviderKey | null;
  shouldQueueAccount?: (account: Account) => boolean;
}) {
  const dashboardApi = useDashboardApi();
  const quotaByAccountId = useState<Record<string, AccountQuotaInfo>>("account-quota-by-account-id", () => ({}));
  const quotaErrorByAccountId = useState<Record<string, string>>("account-quota-error-by-account-id", () => ({}));
  const quotaLoadingByAccountId = useState<Record<string, boolean>>("account-quota-loading-by-account-id", () => ({}));
  const hydratedAccountIds = useState<Record<string, boolean>>("account-quota-hydrated-account-ids", () => ({}));
  let quotaQueueRunId = 0;
  let quotaRunInFlight: Promise<void> | null = null;
  const quotaLoadingRunByAccountId = new Map<string, number>();

  function cancelQuotaQueue() {
    quotaQueueRunId += 1;
  }

  function setQuotaLoading(accountId: string, loading: boolean) {
    quotaLoadingByAccountId.value = loading
      ? { ...quotaLoadingByAccountId.value, [accountId]: true }
      : Object.fromEntries(Object.entries(quotaLoadingByAccountId.value).filter(([key]) => key !== accountId));
  }

  function pruneQuotaState() {
    const accountIds = new Set(options.accounts.value.map((account) => account.id));
    quotaErrorByAccountId.value = Object.fromEntries(Object.entries(quotaErrorByAccountId.value).filter(([accountId]) => accountIds.has(accountId)));
    quotaLoadingByAccountId.value = Object.fromEntries(Object.entries(quotaLoadingByAccountId.value).filter(([accountId]) => accountIds.has(accountId)));
    for (const accountId of quotaLoadingRunByAccountId.keys()) {
      if (!accountIds.has(accountId)) quotaLoadingRunByAccountId.delete(accountId);
    }
  }

  async function hydrateQuotaCache() {
    if (!import.meta.client) return;

    const accountsToHydrate = options.quotaCapableAccounts.value.filter((account) => !hydratedAccountIds.value[account.id]);
    if (accountsToHydrate.length === 0) return;

    const cachedQuotas = await readCachedQuotas(accountsToHydrate.map((account) => account.id));
    const nextQuotaByAccountId = { ...quotaByAccountId.value };
    const nextErrorByAccountId = { ...quotaErrorByAccountId.value };
    const nextHydratedAccountIds = { ...hydratedAccountIds.value };
    let hasQuotaChanges = false;
    let hasErrorChanges = false;

    for (const [index, cached] of cachedQuotas.entries()) {
      const account = accountsToHydrate[index];
      if (!account) continue;

      nextHydratedAccountIds[account.id] = true;
      if (!cached || cached.accountId !== account.id || cached.provider !== options.toQuotaProvider(account.provider)) continue;

      nextQuotaByAccountId[account.id] = cached.quota;
      hasQuotaChanges = true;

      if (cached.error) {
        nextErrorByAccountId[account.id] = cached.error;
        hasErrorChanges = true;
      }
    }

    for (const account of accountsToHydrate) nextHydratedAccountIds[account.id] = true;
    hydratedAccountIds.value = nextHydratedAccountIds;
    if (hasQuotaChanges) quotaByAccountId.value = nextQuotaByAccountId;
    if (hasErrorChanges) quotaErrorByAccountId.value = nextErrorByAccountId;
  }

  async function loadAccountQuota(account: Account, loadOptions: LoadAccountQuotaOptions = {}) {
    const { refreshExisting = false, forceRefresh = false, runId } = loadOptions;
    const provider = options.toQuotaProvider(account.provider);
    if (!provider || (quotaLoadingByAccountId.value[account.id] && !forceRefresh)) return;
    if (quotaByAccountId.value[account.id] && !refreshExisting) return;

    const hadQuota = Boolean(quotaByAccountId.value[account.id]);
    setQuotaLoading(account.id, true);
    quotaErrorByAccountId.value = { ...quotaErrorByAccountId.value, [account.id]: "" };

    try {
      const result = await dashboardApi.accounts.quota({ provider, accountId: account.id, forceRefresh });
      if (runId !== undefined && runId !== quotaQueueRunId) return;
      if (!result.success) throw new Error(result.error);

      quotaByAccountId.value = { ...quotaByAccountId.value, [account.id]: result.data };
      quotaErrorByAccountId.value = Object.fromEntries(Object.entries(quotaErrorByAccountId.value).filter(([accountId]) => accountId !== account.id));
      await writeCachedQuota(account, provider, result.data);
    } catch (error) {
      if (runId !== undefined && runId !== quotaQueueRunId) return;

      const message = error instanceof Error ? error.message : "Failed to fetch quota data";
      if (refreshExisting || !hadQuota) quotaErrorByAccountId.value = { ...quotaErrorByAccountId.value, [account.id]: message };
    } finally {
      setQuotaLoading(account.id, false);
    }
  }

  async function runQuotaQueue(accounts = options.quotaCapableAccounts.value, refreshOptions: RunQuotaRefreshOptions | boolean = {}) {
    const normalizedOptions = typeof refreshOptions === "boolean" ? { refreshExisting: refreshOptions } : refreshOptions;
    const { refreshExisting = false, forceRefresh = false } = normalizedOptions;
    const runId = ++quotaQueueRunId;
    let loadingAccountIds: string[] = [];

    const run = async () => {
      const queueableAccounts = accounts.filter((account) => options.shouldQueueAccount?.(account) ?? true);
      const accountsToFetch = queueableAccounts.filter((account) => {
        if (quotaLoadingByAccountId.value[account.id]) return false;
        if (quotaByAccountId.value[account.id] && !refreshExisting) return false;
        return Boolean(options.toQuotaProvider(account.provider));
      });

      if (accountsToFetch.length === 0) return;

      const hadQuotaByAccountId = Object.fromEntries(accountsToFetch.map((account) => [account.id, Boolean(quotaByAccountId.value[account.id])]));
      loadingAccountIds = accountsToFetch.map((account) => account.id);
      accountsToFetch.forEach((account) => {
        quotaLoadingRunByAccountId.set(account.id, runId);
        setQuotaLoading(account.id, true);
      });
      quotaErrorByAccountId.value = { ...quotaErrorByAccountId.value, ...Object.fromEntries(accountsToFetch.map((account) => [account.id, ""])) };

      const accountsByProvider = new Map<QuotaProviderKey, Account[]>();
      for (const account of accountsToFetch) {
        const provider = options.toQuotaProvider(account.provider);
        if (!provider) continue;
        accountsByProvider.set(provider, [...(accountsByProvider.get(provider) ?? []), account]);
      }

      const providerResults = await Promise.all(Array.from(accountsByProvider.entries()).map(async ([provider, providerAccounts]) => {
        try {
          const result = await dashboardApi.accounts.quotas({ provider, accountIds: providerAccounts.map((account) => account.id), forceRefresh });
          if (!result.success) throw new Error(result.error);
          return { ok: true as const, provider, providerAccounts, data: result.data };
        } catch (error) {
          return { ok: false as const, providerAccounts, error };
        }
      }));

      if (runId !== quotaQueueRunId) return;

      const nextQuotaByAccountId = { ...quotaByAccountId.value };
      const nextErrorByAccountId = { ...quotaErrorByAccountId.value };
      const cacheWrites: Array<Promise<void>> = [];

      for (const providerResult of providerResults) {
        if (!providerResult.ok) {
          const message = providerResult.error instanceof Error ? providerResult.error.message : "Failed to fetch quota data";
          for (const account of providerResult.providerAccounts.filter((account) => refreshExisting || !hadQuotaByAccountId[account.id])) nextErrorByAccountId[account.id] = message;
          continue;
        }

        for (const account of providerResult.providerAccounts) {
          const accountResult = providerResult.data[account.id];
          if (!accountResult) continue;

          if (accountResult.success) {
            nextQuotaByAccountId[account.id] = accountResult.data;
            cacheWrites.push(writeCachedQuota(account, providerResult.provider, accountResult.data));
          } else if (refreshExisting || !hadQuotaByAccountId[account.id]) {
            nextErrorByAccountId[account.id] = accountResult.error;
          }
        }
      }

      quotaByAccountId.value = nextQuotaByAccountId;
      quotaErrorByAccountId.value = Object.fromEntries(Object.entries(nextErrorByAccountId).filter(([accountId]) => !nextQuotaByAccountId[accountId]));
      await Promise.all(cacheWrites);
    };

    const runPromise = run().finally(() => {
      loadingAccountIds.forEach((accountId) => {
        if (quotaLoadingRunByAccountId.get(accountId) !== runId) return;
        quotaLoadingRunByAccountId.delete(accountId);
        setQuotaLoading(accountId, false);
      });
      if (quotaRunInFlight === runPromise) quotaRunInFlight = null;
    });
    quotaRunInFlight = runPromise;
    await quotaRunInFlight;
  }

  async function waitForQuotaQueue() {
    await quotaRunInFlight;
  }

  return {
    quotaByAccountId,
    quotaErrorByAccountId,
    quotaLoadingByAccountId,
    cancelQuotaQueue,
    hydrateQuotaCache,
    loadAccountQuota,
    pruneQuotaState,
    runQuotaQueue,
    waitForQuotaQueue,
  };
}
