import type { Accessor } from "solid-js";
import { Effect } from "effect";
import { failureText, settle } from "~/lib/settle";
import type { ProviderDetailData, QuotaProviderKey } from "~/lib/api-types";
import { api } from "~/api";
import { quotaStore } from "~/lib/quota-store";

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

export interface QuotaMonitorOptions {
  accounts: Accessor<Account[]>;
  quotaCapableAccounts: Accessor<Account[]>;
  toQuotaProvider: (provider: string) => QuotaProviderKey | null;
  shouldQueueAccount?: (account: Account) => boolean;
}

export function createQuotaMonitor(options: QuotaMonitorOptions) {
  const quotaById = quotaStore.quotaById;
  const errorById = quotaStore.errorById;
  const loadingById = quotaStore.loadingById;
  const setQuotaById = quotaStore.setQuotaById;
  const setErrorById = quotaStore.setErrorById;
  const setLoadingById = quotaStore.setLoadingById;

  let queueRunId = 0;
  let runInFlight: Promise<void> | null = null;
  const loadingRun = new Map<string, number>();

  function cancelQuotaQueue() {
    queueRunId += 1;
  }

  function setQuotaLoading(accountId: string, loading: boolean) {
    setLoadingById((current) =>
      loading
        ? { ...current, [accountId]: true }
        : Object.fromEntries(Object.entries(current).filter(([key]) => key !== accountId))
    );
  }

  function pruneQuotaState() {
    const accountIds = new Set(options.accounts().map((account) => account.id));
    setErrorById((current) => Object.fromEntries(Object.entries(current).filter(([accountId]) => accountIds.has(accountId))));
    setLoadingById((current) => Object.fromEntries(Object.entries(current).filter(([accountId]) => accountIds.has(accountId))));
    for (const accountId of loadingRun.keys()) {
      if (!accountIds.has(accountId)) loadingRun.delete(accountId);
    }
  }

  async function loadAccountQuota(account: Account, loadOptions: LoadOptions = {}) {
    const { refreshExisting = false, forceRefresh = false, runId } = loadOptions;
    const provider = options.toQuotaProvider(account.provider);
    if (!provider || (loadingById()[account.id] && !forceRefresh)) return;
    if (quotaById()[account.id] && !refreshExisting) return;

    const hadQuota = Boolean(quotaById()[account.id]);
    setQuotaLoading(account.id, true);
    setErrorById((current) => ({ ...current, [account.id]: "" }));

    const fetched = await settle(() => api.accounts.quota({ provider, accountId: account.id, forceRefresh }));
    if (runId !== undefined && runId !== queueRunId) return;
    if (fetched.ok && fetched.value.success) {
      const quotaData = fetched.value.data;
      setQuotaById((current) => ({ ...current, [account.id]: quotaData }));
      setErrorById((current) => Object.fromEntries(Object.entries(current).filter(([accountId]) => accountId !== account.id)));
    } else {
      const message = failureText(fetched, "Failed to fetch quota data");
      if (refreshExisting || !hadQuota) setErrorById((current) => ({ ...current, [account.id]: message }));
    }
    setQuotaLoading(account.id, false);
  }

  async function runQuotaQueue(
    accounts = options.quotaCapableAccounts(),
    refreshOptions: RefreshOptions | boolean = {}
  ) {
    const normalizedOptions = typeof refreshOptions === "boolean" ? { refreshExisting: refreshOptions } : refreshOptions;
    const { refreshExisting = false, forceRefresh = false } = normalizedOptions;
    const runId = ++queueRunId;
    let loadingAccountIds: string[] = [];

    const run = async () => {
      const queueableAccounts = accounts.filter((account) => options.shouldQueueAccount?.(account) ?? true);
      const accountsToFetch = queueableAccounts.filter((account) => {
        if (loadingById()[account.id]) return false;
        if (quotaById()[account.id] && !refreshExisting) return false;
        return Boolean(options.toQuotaProvider(account.provider));
      });

      if (accountsToFetch.length === 0) return;

      const hadQuota = Object.fromEntries(accountsToFetch.map((account) => [account.id, Boolean(quotaById()[account.id])]));
      loadingAccountIds = accountsToFetch.map((account) => account.id);
      accountsToFetch.forEach((account) => {
        loadingRun.set(account.id, runId);
        setQuotaLoading(account.id, true);
      });
      setErrorById((current) => ({ ...current, ...Object.fromEntries(accountsToFetch.map((account) => [account.id, ""])) }));

      const accountsByProvider = new Map<QuotaProviderKey, Account[]>();
      for (const account of accountsToFetch) {
        const provider = options.toQuotaProvider(account.provider);
        if (!provider) continue;
        accountsByProvider.set(provider, [...(accountsByProvider.get(provider) ?? []), account]);
      }

      const providerResults = await Effect.runPromise(
        Effect.all(
          Array.from(accountsByProvider.entries()).map(([provider, providerAccounts]) =>
            Effect.promise(async () => {
              const fetched = await settle(() =>
                api.accounts.quotas({
                  provider,
                  accountIds: providerAccounts.map((account) => account.id),
                  forceRefresh,
                })
              );
              if (!fetched.ok) return { ok: false as const, providerAccounts, error: fetched.error };
              if (!fetched.value.success) {
                return { ok: false as const, providerAccounts, error: new Error(fetched.value.error) };
              }
              return { ok: true as const, provider, providerAccounts, data: fetched.value.data };
            })
          ),
          { concurrency: Math.max(1, accountsByProvider.size) }
        )
      );

      if (runId !== queueRunId) return;

      const nextQuota = { ...quotaById() };
      const nextError = { ...errorById() };

      for (const providerResult of providerResults) {
        if (!providerResult.ok) {
          const message = providerResult.error instanceof Error ? providerResult.error.message : "Failed to fetch quota data";
          for (const account of providerResult.providerAccounts.filter((account) => refreshExisting || !hadQuota[account.id])) {
            nextError[account.id] = message;
          }
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

      setQuotaById(nextQuota);
      setErrorById(Object.fromEntries(Object.entries(nextError).filter(([accountId]) => !nextQuota[accountId])));
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
