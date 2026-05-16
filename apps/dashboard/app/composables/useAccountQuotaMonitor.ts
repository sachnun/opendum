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
const QUOTA_FETCH_TIMEOUT_MS = 7000;
const QUOTA_DB_NAME = "opendum-dashboard";
const QUOTA_STORE_NAME = "account-quota";
const quotaStore = import.meta.client ? createStore(QUOTA_DB_NAME, QUOTA_STORE_NAME) : null;

class QuotaFetchTimeoutError extends Error {
  constructor() {
    super("Quota fetch timed out");
    this.name = "QuotaFetchTimeoutError";
  }
}

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

  async function loadAccountQuota(account: Account, forceRefresh = false, runId?: number, refreshExisting = false) {
    const provider = options.toQuotaProvider(account.provider);
    if (!provider || quotaLoadingByAccountId.value[account.id]) return;
    if (!forceRefresh && quotaByAccountId.value[account.id] && !refreshExisting) return;

    const hadQuota = Boolean(quotaByAccountId.value[account.id]);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(new QuotaFetchTimeoutError()), QUOTA_FETCH_TIMEOUT_MS);
    setQuotaLoading(account.id, true);
    quotaErrorByAccountId.value = { ...quotaErrorByAccountId.value, [account.id]: "" };

    try {
      const result = await dashboardApi.accounts.quota({ provider, accountId: account.id, forceRefresh }, { signal: abortController.signal });
      if (runId !== undefined && runId !== quotaQueueRunId) return;
      if (!result.success) throw new Error(result.error);

      quotaByAccountId.value = { ...quotaByAccountId.value, [account.id]: result.data };
      quotaErrorByAccountId.value = Object.fromEntries(Object.entries(quotaErrorByAccountId.value).filter(([accountId]) => accountId !== account.id));
      await writeCachedQuota(account, provider, result.data);
    } catch (error) {
      if (runId !== undefined && runId !== quotaQueueRunId) return;
      if (abortController.signal.aborted) return;

      const message = error instanceof Error ? error.message : "Failed to fetch quota data";
      if (!hadQuota) quotaErrorByAccountId.value = { ...quotaErrorByAccountId.value, [account.id]: message };
    } finally {
      clearTimeout(timeout);
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
      ];

      for (const [index, account] of accountsToFetch.entries()) {
        if (runId !== quotaQueueRunId) return;
        if (index > 0 || queueOptions.append) {
          const delay = account.isActive ? ENABLED_QUOTA_FETCH_DELAY_MS : DISABLED_QUOTA_FETCH_DELAY_MS;
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (runId !== quotaQueueRunId) return;
        }

        if (quotaLoadingByAccountId.value[account.id]) {
          while (quotaLoadingByAccountId.value[account.id] && runId === quotaQueueRunId) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (runId !== quotaQueueRunId) return;
        }
        await loadAccountQuota(account, false, runId, refreshExisting);
      }
    };

    const queueRun = queueOptions.append ? quotaQueueTail.then(run, run) : run();
    quotaQueueTail = queueRun.catch(() => {});
    await queueRun;
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
  };
}
