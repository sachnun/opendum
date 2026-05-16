import { createStore, getMany, set } from "idb-keyval";
import type { ComputedRef } from "vue";
import type { AccountQuotaInfo, ProviderDetailData, QuotaProviderKey } from "../../lib/dashboard-api-types";

type Account = ProviderDetailData["accounts"][number];

type CachedAccountQuota = {
  accountId: string;
  provider: QuotaProviderKey;
  quota: AccountQuotaInfo;
  error?: string;
  cachedAt: number;
};

type RunQuotaQueueOptions = {
  append?: boolean;
};

const ENABLED_QUOTA_FETCH_DELAY_MS = 500;
const DISABLED_QUOTA_FETCH_DELAY_MS = 1500;
const QUOTA_BATCH_SIZE = 3;
const QUOTA_DB_NAME = "opendum-dashboard";
const QUOTA_STORE_NAME = "account-quota";
const quotaStore = import.meta.client ? createStore(QUOTA_DB_NAME, QUOTA_STORE_NAME) : null;

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
  let quotaQueueTail: Promise<void> = Promise.resolve();

  function cancelQuotaQueue() {
    quotaQueueRunId += 1;
    quotaQueueTail = Promise.resolve();
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

  async function loadAccountQuota(account: Account, refreshExisting = false, runId?: number) {
    const provider = options.toQuotaProvider(account.provider);
    if (!provider || quotaLoadingByAccountId.value[account.id]) return;
    if (quotaByAccountId.value[account.id] && !refreshExisting) return;

    const hadQuota = Boolean(quotaByAccountId.value[account.id]);
    setQuotaLoading(account.id, true);
    quotaErrorByAccountId.value = { ...quotaErrorByAccountId.value, [account.id]: "" };

    try {
      const result = await dashboardApi.accounts.quota({ provider, accountId: account.id });
      if (runId !== undefined && runId !== quotaQueueRunId) return;
      if (!result.success) throw new Error(result.error);

      quotaByAccountId.value = { ...quotaByAccountId.value, [account.id]: result.data };
      quotaErrorByAccountId.value = Object.fromEntries(Object.entries(quotaErrorByAccountId.value).filter(([accountId]) => accountId !== account.id));
      await writeCachedQuota(account, provider, result.data);
    } catch (error) {
      if (runId !== undefined && runId !== quotaQueueRunId) return;

      const message = error instanceof Error ? error.message : "Failed to fetch quota data";
      if (!hadQuota) quotaErrorByAccountId.value = { ...quotaErrorByAccountId.value, [account.id]: message };
    } finally {
      setQuotaLoading(account.id, false);
    }
  }

  async function runQuotaQueue(accounts = options.quotaCapableAccounts.value, refreshExisting = false, queueOptions: RunQuotaQueueOptions = {}) {
    const runId = queueOptions.append ? quotaQueueRunId : ++quotaQueueRunId;
    const run = async () => {
      const queueableAccounts = accounts.filter((account) => options.shouldQueueAccount?.(account) ?? true);
      const accountsToFetch = [
        ...queueableAccounts.filter((account) => account.isActive),
        ...queueableAccounts.filter((account) => !account.isActive),
      ].filter((account) => {
        if (quotaLoadingByAccountId.value[account.id]) return false;
        if (quotaByAccountId.value[account.id] && !refreshExisting) return false;
        return Boolean(options.toQuotaProvider(account.provider));
      });

      if (accountsToFetch.length === 0) return;
      if (queueOptions.append) {
        const firstAccount = accountsToFetch[0];
        const delay = firstAccount?.isActive ? ENABLED_QUOTA_FETCH_DELAY_MS : DISABLED_QUOTA_FETCH_DELAY_MS;
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (runId !== quotaQueueRunId) return;
      }

      const accountsByProvider = new Map<QuotaProviderKey, Account[]>();
      for (const account of accountsToFetch) {
        const provider = options.toQuotaProvider(account.provider);
        if (!provider) continue;
        accountsByProvider.set(provider, [...(accountsByProvider.get(provider) ?? []), account]);
      }

      for (const [provider, providerAccounts] of accountsByProvider) {
        if (runId !== quotaQueueRunId) return;

        for (let batchStart = 0; batchStart < providerAccounts.length; batchStart += QUOTA_BATCH_SIZE) {
          if (runId !== quotaQueueRunId) return;

          const batchAccounts = providerAccounts.slice(batchStart, batchStart + QUOTA_BATCH_SIZE);
          const hadQuotaByAccountId = Object.fromEntries(batchAccounts.map((account) => [account.id, Boolean(quotaByAccountId.value[account.id])]));
          batchAccounts.forEach((account) => setQuotaLoading(account.id, true));
          quotaErrorByAccountId.value = { ...quotaErrorByAccountId.value, ...Object.fromEntries(batchAccounts.map((account) => [account.id, ""])) };

          try {
            const result = await dashboardApi.accounts.quotas({ provider, accountIds: batchAccounts.map((account) => account.id) });
            if (runId !== quotaQueueRunId) return;
            if (!result.success) throw new Error(result.error);

            let nextQuotaByAccountId = { ...quotaByAccountId.value };
            let nextErrorByAccountId = { ...quotaErrorByAccountId.value };

            for (const account of batchAccounts) {
              const accountResult = result.data[account.id];
              if (!accountResult) continue;

              if (accountResult.success) {
                nextQuotaByAccountId = { ...nextQuotaByAccountId, [account.id]: accountResult.data };
                nextErrorByAccountId = Object.fromEntries(Object.entries(nextErrorByAccountId).filter(([accountId]) => accountId !== account.id));
                await writeCachedQuota(account, provider, accountResult.data);
              } else if (!hadQuotaByAccountId[account.id]) {
                nextErrorByAccountId = { ...nextErrorByAccountId, [account.id]: accountResult.error };
              }
            }

            quotaByAccountId.value = nextQuotaByAccountId;
            quotaErrorByAccountId.value = nextErrorByAccountId;
          } catch (error) {
            if (runId !== quotaQueueRunId) return;

            const message = error instanceof Error ? error.message : "Failed to fetch quota data";
            quotaErrorByAccountId.value = { ...quotaErrorByAccountId.value, ...Object.fromEntries(batchAccounts.filter((account) => !hadQuotaByAccountId[account.id]).map((account) => [account.id, message])) };
          } finally {
            batchAccounts.forEach((account) => setQuotaLoading(account.id, false));
          }
        }
      }
    };

    const queueRun = queueOptions.append ? quotaQueueTail.then(run, run) : run();
    quotaQueueTail = queueRun.catch(() => {});
    await queueRun;
  }

  async function waitForQuotaQueue() {
    await quotaQueueTail;
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
