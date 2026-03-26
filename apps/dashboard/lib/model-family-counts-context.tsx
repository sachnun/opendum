"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ModelFamilyCounts } from "@/lib/navigation";

interface ModelFamilyCountsContextValue {
  /** Current counts (override if set, otherwise the server defaults). */
  counts: ModelFamilyCounts;
  /** Replace counts with client-side filtered values. */
  setCounts: (counts: ModelFamilyCounts) => void;
  /** Reset back to the server-computed defaults. */
  resetCounts: () => void;
}

const ModelFamilyCountsContext = createContext<ModelFamilyCountsContextValue | null>(null);

interface ModelFamilyCountsProviderProps {
  defaultCounts: ModelFamilyCounts;
  children: React.ReactNode;
}

export function ModelFamilyCountsProvider({
  defaultCounts,
  children,
}: ModelFamilyCountsProviderProps) {
  const [overrideCounts, setOverrideCounts] = useState<ModelFamilyCounts | null>(null);

  const setCounts = useCallback((next: ModelFamilyCounts) => {
    setOverrideCounts(next);
  }, []);

  const resetCounts = useCallback(() => {
    setOverrideCounts(null);
  }, []);

  const value = useMemo<ModelFamilyCountsContextValue>(
    () => ({
      counts: overrideCounts ?? defaultCounts,
      setCounts,
      resetCounts,
    }),
    [overrideCounts, defaultCounts, setCounts, resetCounts],
  );

  return (
    <ModelFamilyCountsContext.Provider value={value}>
      {children}
    </ModelFamilyCountsContext.Provider>
  );
}

export function useModelFamilyCounts(): ModelFamilyCountsContextValue {
  const ctx = useContext(ModelFamilyCountsContext);
  if (!ctx) {
    throw new Error("useModelFamilyCounts must be used within ModelFamilyCountsProvider");
  }
  return ctx;
}
