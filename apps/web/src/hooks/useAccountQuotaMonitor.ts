import { useCallback, useEffect, useRef, useState } from "react";
import { getMany, set } from "idb-keyval";
import { createDashboardIndexedDbStore } from "../lib/dashboardIndexedDb";
import type { AccountQuotaInfo, ProviderDetailData, QuotaProviderKey } from "../lib/dashboard-api-types";
import { useDashboardApi } from "./useDashboardApi";

type Account = ProviderDetailData["accounts"][number];

type CachedAccountQuota = {
  accountId: string;
  provider: QuotaProviderKey;
  quota: AccountQuotaInfo;
  error?: string;
  cachedAt: number;
};

const QUOTA_DB_NAME = "opendum-dashboard";
const QUOTA_STORE_NAME = "account-quota";
const quotaStore = createDashboardIndexedDbStore(QUOTA_DB_NAME, QUOTA_STORE_NAME);

function getQuotaCacheKey(accountId: string) {
  return `account-quota:${accountId}`;
}

async function readCachedQuotas(accountIds: string[]): Promise<CachedAccountQuota[]> {
  if (!quotaStore || accountIds.length === 0) return [];
  try {
    return (await getMany<CachedAccountQuota>(accountIds.map(getQuotaCacheKey), quotaStore)).filter((v): v is CachedAccountQuota => v !== undefined);
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

export interface AccountQuotaMonitorOptions {
  accounts: Account[];
  quotaCapableAccounts: Account[];
  toQuotaProvider: (provider: string) => QuotaProviderKey | null;
  shouldQueueAccount?: (account: Account) => boolean;
}

export function useAccountQuotaMonitor(options: AccountQuotaMonitorOptions) {
  const dashboardApi = useDashboardApi();
  const [quotaByAccountId, setQuotaByAccountId] = useState<Record<string, AccountQuotaInfo>>({});
  const [quotaErrorByAccountId, setQuotaErrorByAccountId] = useState<Record<string, string>>({});
  const [quotaLoadingByAccountId, setQuotaLoadingByAccountId] = useState<Record<string, boolean>>({});
  const hydratedAccountIds = useRef<Record<string, boolean>>({});
  const quotaQueueRunId = useRef(0);
  const quotaRunInFlight = useRef<Promise<void> | null>(null);
  const quotaLoadingRunByAccountId = useRef(new Map<string, number>());
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const cancelQuotaQueue = useCallback(() => {
    quotaQueueRunId.current += 1;
  }, []);

  const setQuotaLoading = useCallback((accountId: string, loading: boolean) => {
    setQuotaLoadingByAccountId((current) => loading ? { ...current, [accountId]: true } : Object.fromEntries(Object.entries(current).filter(([key]) => key !== accountId)));
  }, []);

  const pruneQuotaState = useCallback(() => {
    const accountIds = new Set(optionsRef.current.accounts.map((account) => account.id));
    setQuotaErrorByAccountId((current) => Object.fromEntries(Object.entries(current).filter(([accountId]) => accountIds.has(accountId))));
    setQuotaLoadingByAccountId((current) => Object.fromEntries(Object.entries(current).filter(([accountId]) => accountIds.has(accountId))));
    for (const accountId of quotaLoadingRunByAccountId.current.keys()) {
      if (!accountIds.has(accountId)) quotaLoadingRunByAccountId.current.delete(accountId);
    }
  }, []);

  const hydrateQuotaCache = useCallback(async () => {
    if (typeof window === "undefined") return;
    const accountsToHydrate = optionsRef.current.quotaCapableAccounts.filter((account) => !hydratedAccountIds.current[account.id]);
    if (accountsToHydrate.length === 0) return;

    const cachedQuotas = await readCachedQuotas(accountsToHydrate.map((account) => account.id));
    const nextQuotaByAccountId = { ...quotaByAccountId };
    const nextErrorByAccountId = { ...quotaErrorByAccountId };

    for (const [index, cached] of cachedQuotas.entries()) {
      const account = accountsToHydrate[index];
      if (!account) continue;
      hydratedAccountIds.current[account.id] = true;
      if (!cached || cached.accountId !== account.id || cached.provider !== optionsRef.current.toQuotaProvider(account.provider)) continue;
      nextQuotaByAccountId[account.id] = cached.quota;
      if (cached.error) nextErrorByAccountId[account.id] = cached.error;
    }
    for (const account of accountsToHydrate) hydratedAccountIds.current[account.id] = true;
    setQuotaByAccountId(nextQuotaByAccountId);
    setQuotaErrorByAccountId(nextErrorByAccountId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAccountQuota = useCallback(async (account: Account, loadOptions: { refreshExisting?: boolean; forceRefresh?: boolean; runId?: number } = {}) => {
    const { refreshExisting = false, forceRefresh = false, runId } = loadOptions;
    const provider = optionsRef.current.toQuotaProvider(account.provider);
    if (!provider || (quotaLoadingByAccountId[account.id] && !forceRefresh)) return;
    if (quotaByAccountId[account.id] && !refreshExisting) return;

    const hadQuota = Boolean(quotaByAccountId[account.id]);
    setQuotaLoading(account.id, true);
    setQuotaErrorByAccountId((current) => ({ ...current, [account.id]: "" }));

    try {
      const result = await dashboardApi.accounts.quota({ provider, accountId: account.id, forceRefresh });
      if (runId !== undefined && runId !== quotaQueueRunId.current) return;
      if (!result.success) throw new Error(result.error);
      setQuotaByAccountId((current) => ({ ...current, [account.id]: result.data }));
      setQuotaErrorByAccountId((current) => Object.fromEntries(Object.entries(current).filter(([accountId]) => accountId !== account.id)));
      await writeCachedQuota(account, provider, result.data);
    } catch (error) {
      if (runId !== undefined && runId !== quotaQueueRunId.current) return;
      const message = error instanceof Error ? error.message : "Failed to fetch quota data";
      if (refreshExisting || !hadQuota) setQuotaErrorByAccountId((current) => ({ ...current, [account.id]: message }));
    } finally {
      setQuotaLoading(account.id, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardApi]);

  const runQuotaQueue = useCallback(async (accounts?: Account[], refreshOptions: { refreshExisting?: boolean; forceRefresh?: boolean } = {}) => {
    const { refreshExisting = false, forceRefresh = false } = refreshOptions;
    const runId = ++quotaQueueRunId.current;
    let loadingAccountIds: string[] = [];

    const run = async () => {
      const queueableAccounts = (accounts ?? optionsRef.current.quotaCapableAccounts).filter((account) => optionsRef.current.shouldQueueAccount?.(account) ?? true);
      const accountsToFetch = queueableAccounts.filter((account) => {
        if (quotaLoadingByAccountId[account.id]) return false;
        if (quotaByAccountId[account.id] && !refreshExisting) return false;
        return Boolean(optionsRef.current.toQuotaProvider(account.provider));
      });
      if (accountsToFetch.length === 0) return;

      const hadQuotaByAccountId = Object.fromEntries(accountsToFetch.map((account) => [account.id, Boolean(quotaByAccountId[account.id])]));
      loadingAccountIds = accountsToFetch.map((account) => account.id);
      for (const account of accountsToFetch) {
        quotaLoadingRunByAccountId.current.set(account.id, runId);
        setQuotaLoading(account.id, true);
      }
      setQuotaErrorByAccountId((current) => ({ ...current, ...Object.fromEntries(accountsToFetch.map((account) => [account.id, ""])) }));

      const accountsByProvider = new Map<QuotaProviderKey, Account[]>();
      for (const account of accountsToFetch) {
        const provider = optionsRef.current.toQuotaProvider(account.provider);
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

      if (runId !== quotaQueueRunId.current) return;

      const nextQuotaByAccountId = { ...quotaByAccountId };
      const nextErrorByAccountId = { ...quotaErrorByAccountId };
      const cacheWrites: Array<Promise<void>> = [];

      for (const providerResult of providerResults) {
        if (!providerResult.ok) {
          const message = providerResult.error instanceof Error ? providerResult.error.message : "Failed to fetch quota data";
          for (const account of providerResult.providerAccounts.filter((acc) => refreshExisting || !hadQuotaByAccountId[acc.id])) nextErrorByAccountId[account.id] = message;
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

      setQuotaByAccountId(nextQuotaByAccountId);
      setQuotaErrorByAccountId(Object.fromEntries(Object.entries(nextErrorByAccountId).filter(([accountId]) => !nextQuotaByAccountId[accountId])));
      await Promise.all(cacheWrites);
    };

    const runPromise = run().finally(() => {
      loadingAccountIds.forEach((accountId) => {
        if (quotaLoadingRunByAccountId.current.get(accountId) !== runId) return;
        quotaLoadingRunByAccountId.current.delete(accountId);
        setQuotaLoading(accountId, false);
      });
      if (quotaRunInFlight.current === runPromise) quotaRunInFlight.current = null;
    });
    quotaRunInFlight.current = runPromise;
    await quotaRunInFlight.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardApi]);

  useEffect(() => {
    void hydrateQuotaCache();
  }, [hydrateQuotaCache]);

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
