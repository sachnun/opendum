import { useMemo, useState } from "react";
import { PROVIDER_ACCOUNT_DEFINITIONS, type ProviderAccountKey } from "../../lib/provider-accounts";
import type { AccountOverviewData } from "../../lib/dashboard-api-types";
import { useDashboardApi } from "../../hooks/useDashboardApi";
import { useDashboardAudit } from "../../hooks/useDashboardAudit";
import { dashboardDataKeys, useDashboardData } from "../../hooks/useDashboardDataInvalidation";
import { AddAccountDialog } from "../../components/AddAccountDialog";
import { DashboardDataNotice } from "../../components/DashboardDataNotice";
import { ProviderOverviewCard } from "../../components/ProviderOverviewCard";
import { UiSkeleton } from "../../components/ui/UiSkeleton";

export default function DashboardIndexPage() {
  const dashboardApi = useDashboardApi();
  const { isAuditMode } = useDashboardAudit();
  const { data, error, isLoading, refresh } = useDashboardData<AccountOverviewData>(dashboardDataKeys.accountsOverview, () => dashboardApi.accounts.overview(), { enabled: true });

  const summaries = data?.summaries ?? null;
  const pinnedProviders = useMemo(() => new Set(data?.pinnedProviders ?? []), [data]);

  const providerAvailabilityOrder = { active: 0, inactive: 1 } as const;
  const providerStatusOrder = { error: 0, warning: 1, normal: 2 } as const;

  const sortedProviders = useMemo(() => {
    return [...PROVIDER_ACCOUNT_DEFINITIONS].sort((a, b) => {
      const aPinned = pinnedProviders.has(a.key) ? 0 : 1;
      const bPinned = pinnedProviders.has(b.key) ? 0 : 1;
      const aSummary = summaries?.[a.key];
      const bSummary = summaries?.[b.key];
      const aAvailability = (aSummary?.active ?? 0) > 0 ? "active" : "inactive";
      const bAvailability = (bSummary?.active ?? 0) > 0 ? "active" : "inactive";
      const aIndicator = (aSummary?.indicator ?? "normal") as keyof typeof providerStatusOrder;
      const bIndicator = (bSummary?.indicator ?? "normal") as keyof typeof providerStatusOrder;
      const aConnected = summaries?.[a.key]?.connected ?? 0;
      const bConnected = summaries?.[b.key]?.connected ?? 0;
      return aPinned - bPinned
        || providerAvailabilityOrder[aAvailability] - providerAvailabilityOrder[bAvailability]
        || providerStatusOrder[aIndicator] - providerStatusOrder[bIndicator]
        || bConnected - aConnected
        || a.label.localeCompare(b.label);
    });
  }, [pinnedProviders, summaries]);

  return (
    <div className="space-y-6">
      <div className="dashboard-header-divider">
        <div className="flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="inline-flex min-h-9 items-center gap-2 text-xl font-semibold">Provider Accounts</h2>
          <div className="flex w-full items-center sm:w-auto">
            <AddAccountDialog readonly={isAuditMode} triggerClass="flex-1 sm:w-auto sm:flex-none" onConnected={() => void refresh()} />
          </div>
        </div>
      </div>

      <DashboardDataNotice error={error} />
      {isLoading && !data ? (
        <UiSkeleton className="h-96 rounded-xl" />
      ) : summaries ? (
        <div className="dashboard-card-grid">
          {sortedProviders.map((provider) => (
            <ProviderOverviewCard
              key={provider.key}
              provider={provider}
              summary={summaries[provider.key]!}
              pinned={pinnedProviders.has(provider.key)}
              readonly={isAuditMode}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export type { ProviderAccountKey };
