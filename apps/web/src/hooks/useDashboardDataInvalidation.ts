import { useCallback, useEffect, useRef, useState } from "react";

export const dashboardDataKeys = {
  shellAccounts: "dashboard-shell-accounts",
  accountsOverview: "dashboard-accounts-overview",
  accountsDetail: (provider: string) => `dashboard-accounts-detail-${provider}`,
  models: "dashboard-models",
  shellModelFamilyCounts: "dashboard-shell-model-family-counts",
  modelSearch: "layout-model-search",
  playgroundOptions: "dashboard-playground-options",
  apiKeys: "dashboard-api-keys",
} as const;

type Listener = () => void;

const versions = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();

function bumpVersion(key: string): void {
  versions.set(key, (versions.get(key) ?? 0) + 1);
  const set = listeners.get(key);
  if (set) {
    for (const listener of [...set]) listener();
  }
}

/** Subscribe to a data key; re-renders on invalidation. */
export function useDataVersion(key: string): number {
  const [version, setVersion] = useState(() => versions.get(key) ?? 0);
  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    const set = listeners.get(key) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(key, set);
    return () => {
      set.delete(listener);
    };
  }, [key]);
  return version;
}

export function useDashboardDataInvalidation() {
  const refreshDashboardData = useCallback((keys: string | string[]) => {
    const keyList = Array.isArray(keys) ? keys : [keys];
    if (keyList.includes("*")) {
      for (const key of [...versions.keys()]) bumpVersion(key);
      return;
    }
    for (const key of keyList) bumpVersion(key);
  }, []);

  const clearDashboardData = useCallback((keys: string | string[]) => {
    const keyList = Array.isArray(keys) ? keys : [keys];
    for (const key of keyList) {
      versions.delete(key);
      bumpVersion(key);
    }
  }, []);

  const invalidateAccountCollection = useCallback((provider: string) => {
    refreshDashboardData([
      dashboardDataKeys.shellAccounts,
      dashboardDataKeys.accountsOverview,
      dashboardDataKeys.accountsDetail(provider),
      dashboardDataKeys.models,
      dashboardDataKeys.shellModelFamilyCounts,
      dashboardDataKeys.modelSearch,
      dashboardDataKeys.playgroundOptions,
      dashboardDataKeys.apiKeys,
    ]);
  }, [refreshDashboardData]);

  const invalidateAccountOverview = useCallback(() => {
    refreshDashboardData([dashboardDataKeys.shellAccounts, dashboardDataKeys.accountsOverview]);
  }, [refreshDashboardData]);

  const clearAccountDependentOptions = useCallback(() => {
    clearDashboardData([dashboardDataKeys.playgroundOptions, dashboardDataKeys.apiKeys]);
  }, [clearDashboardData]);

  const invalidateModelAvailability = useCallback(() => {
    refreshDashboardData([
      dashboardDataKeys.modelSearch,
      dashboardDataKeys.shellModelFamilyCounts,
      dashboardDataKeys.playgroundOptions,
      dashboardDataKeys.apiKeys,
    ]);
  }, [refreshDashboardData]);

  const clearModelAvailability = useCallback(() => {
    refreshDashboardData([dashboardDataKeys.models, dashboardDataKeys.modelSearch, dashboardDataKeys.shellModelFamilyCounts]);
  }, [refreshDashboardData]);

  return {
    keys: dashboardDataKeys,
    clearAccountDependentOptions,
    invalidateAccountCollection,
    invalidateAccountOverview,
    invalidateModelAvailability,
    clearModelAvailability,
    refreshDashboardData,
    clearDashboardData,
  };
}

/** Fetch dashboard data with automatic refetch on invalidation events. */
export function useDashboardData<T>(key: string, fetcher: () => Promise<T>, options: { enabled?: boolean; initialData?: T } = {}): { data: T | undefined; refresh: () => Promise<void>; isLoading: boolean; error: Error | null } {
  const version = useDataVersion(key);
  const [data, setData] = useState<T | undefined>(options.initialData);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async () => {
    if (options.enabled === false) return;
    try {
      const value = await fetcherRef.current();
      setData(value);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setIsLoading(false);
    }
  }, [options.enabled]);

  useEffect(() => {
    setIsLoading(true);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);

  return { data, refresh, isLoading, error };
}
