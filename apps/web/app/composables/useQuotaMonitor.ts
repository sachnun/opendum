import type { ComputedRef } from "vue";
import type { AccountQuotaInfo, ProviderDetailData, QuotaProviderKey } from "../../lib/api-types";

type Account = ProviderDetailData["accounts"][number];

type LoadOptions = {
  refreshExisting?: boolean;
  forceRefresh?: boolean;
  runId?: number;
};

type RefreshOptions = {
  refreshExisting?: boolean;
  forceRefresh?: boolean;
};

export function useQuotaMonitor(options: {
  accounts: ComputedRef<Account[]>;
  quotaCapableAccounts: ComputedRef<Account[]>;
  toQuotaProvider: (provider: string) => QuotaProviderKey | null;
  shouldQueueAccount?: (account: Account) => boolean;
}) {
  const api = useApi();
  const quotaById = useState<Record<string, AccountQuotaInfo>>(stateKeys.quotaById, () => ({}));
  const errorById = useState<Record<string, string>>(stateKeys.errorById, () => ({}));
  const loadingById = useState<Record<string, boolean>>(stateKeys.loadingById, () => ({}));
  let queueRunId = 0;
  let runInFlight: Promise<void> | null = null;
  const loadingRun = new Map<string, number>();

  function cancelQuotaQueue() {
    queueRunId += 1;
  }

  function setQuotaLoading(accountId: string, loading: boolean) {
    loadingById.value = loading
      ? { ...loadingById.value, [accountId]: true }
      : Object.fromEntries(Object.entries(loadingById.value).filter(([key]) => key !== accountId));
  }

  function pruneQuotaState() {
    const accountIds = new Set(options.accounts.value.map((account) => account.id));
    errorById.value = Object.fromEntries(Object.entries(errorById.value).filter(([accountId]) => accountIds.has(accountId)));
    loadingById.value = Object.fromEntries(Object.entries(loadingById.value).filter(([accountId]) => accountIds.has(accountId)));
    for (const accountId of loadingRun.keys()) {
      if (!accountIds.has(accountId)) loadingRun.delete(accountId);
    }
  }

  async function loadAccountQuota(account: Account, loadOptions: LoadOptions = {}) {
    const { refreshExisting = false, forceRefresh = false, runId } = loadOptions;
    const provider = options.toQuotaProvider(account.provider);
    if (!provider || (loadingById.value[account.id] && !forceRefresh)) return;
    if (quotaById.value[account.id] && !refreshExisting) return;

    const hadQuota = Boolean(quotaById.value[account.id]);
    setQuotaLoading(account.id, true);
    errorById.value = { ...errorById.value, [account.id]: "" };

    try {
      const result = await api.accounts.quota({ provider, accountId: account.id, forceRefresh });
      if (runId !== undefined && runId !== queueRunId) return;
      if (!result.success) throw new Error(result.error);

      quotaById.value = { ...quotaById.value, [account.id]: result.data };
      errorById.value = Object.fromEntries(Object.entries(errorById.value).filter(([accountId]) => accountId !== account.id));
    } catch (error) {
      if (runId !== undefined && runId !== queueRunId) return;

      const message = error instanceof Error ? error.message : "Failed to fetch quota data";
      if (refreshExisting || !hadQuota) errorById.value = { ...errorById.value, [account.id]: message };
    } finally {
      setQuotaLoading(account.id, false);
    }
  }

  async function runQuotaQueue(accounts = options.quotaCapableAccounts.value, refreshOptions: RefreshOptions | boolean = {}) {
    const normalizedOptions = typeof refreshOptions === "boolean" ? { refreshExisting: refreshOptions } : refreshOptions;
    const { refreshExisting = false, forceRefresh = false } = normalizedOptions;
    const runId = ++queueRunId;
    let loadingAccountIds: string[] = [];

    const run = async () => {
      const queueableAccounts = accounts.filter((account) => options.shouldQueueAccount?.(account) ?? true);
      const accountsToFetch = queueableAccounts.filter((account) => {
        if (loadingById.value[account.id]) return false;
        if (quotaById.value[account.id] && !refreshExisting) return false;
        return Boolean(options.toQuotaProvider(account.provider));
      });

      if (accountsToFetch.length === 0) return;

      const hadQuota = Object.fromEntries(accountsToFetch.map((account) => [account.id, Boolean(quotaById.value[account.id])]));
      loadingAccountIds = accountsToFetch.map((account) => account.id);
      accountsToFetch.forEach((account) => {
        loadingRun.set(account.id, runId);
        setQuotaLoading(account.id, true);
      });
      errorById.value = { ...errorById.value, ...Object.fromEntries(accountsToFetch.map((account) => [account.id, ""])) };

      const accountsByProvider = new Map<QuotaProviderKey, Account[]>();
      for (const account of accountsToFetch) {
        const provider = options.toQuotaProvider(account.provider);
        if (!provider) continue;
        accountsByProvider.set(provider, [...(accountsByProvider.get(provider) ?? []), account]);
      }

      const providerResults = await Promise.all(Array.from(accountsByProvider.entries()).map(async ([provider, providerAccounts]) => {
        try {
          const result = await api.accounts.quotas({ provider, accountIds: providerAccounts.map((account) => account.id), forceRefresh });
          if (!result.success) throw new Error(result.error);
          return { ok: true as const, provider, providerAccounts, data: result.data };
        } catch (error) {
          return { ok: false as const, providerAccounts, error };
        }
      }));

      if (runId !== queueRunId) return;

      const nextQuota = { ...quotaById.value };
      const nextError = { ...errorById.value };

      for (const providerResult of providerResults) {
        if (!providerResult.ok) {
          const message = providerResult.error instanceof Error ? providerResult.error.message : "Failed to fetch quota data";
          for (const account of providerResult.providerAccounts.filter((account) => refreshExisting || !hadQuota[account.id])) nextError[account.id] = message;
          continue;
        }

        for (const account of providerResult.providerAccounts) {
          const accountResult = providerResult.data[account.id];
          if (!accountResult) continue;

          if (accountResult.success) {
            nextQuota[account.id] = accountResult.data;
          } else if (refreshExisting || !hadQuota[account.id]) {
            nextError[account.id] = accountResult.error;
          }
        }
      }

      quotaById.value = nextQuota;
      errorById.value = Object.fromEntries(Object.entries(nextError).filter(([accountId]) => !nextQuota[accountId]));
    };

    const runPromise = run().finally(() => {
      loadingAccountIds.forEach((accountId) => {
        if (loadingRun.get(accountId) !== runId) return;
        loadingRun.delete(accountId);
        setQuotaLoading(accountId, false);
      });
      if (runInFlight === runPromise) runInFlight = null;
    });
    runInFlight = runPromise;
    await runInFlight;
  }

  async function waitForQueue() {
    await runInFlight;
  }

  return {
    quotaById,
    errorById,
    loadingById,
    cancelQuotaQueue,
    loadAccountQuota,
    pruneQuotaState,
    runQuotaQueue,
    waitForQueue,
  };
}
