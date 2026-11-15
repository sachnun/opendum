import { createMemo, type JSX } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { PROVIDER_ACCOUNT_DEFINITIONS } from "@opendum/providers/provider-accounts";
import { compareText } from "@opendum/models/compare";
import { AddAccountDialog } from "~/components/account/AddAccountDialog";
import { ProviderOverviewCard } from "~/components/account/ProviderOverviewCard";
import { DataNotice } from "~/components/common/DataNotice";
import { api } from "~/api";
import { isAuditMode } from "~/lib/audit";
import { dataKeys } from "~/lib/data-keys";
import { createQuery } from "~/lib/query";

const PROVIDER_AVAILABILITY_ORDER = { active: 0, inactive: 1 } as const;
const PROVIDER_STATUS_ORDER = { error: 0, warning: 1, normal: 2 } as const;

const EMPTY_PROVIDER_SUMMARY = {
  connected: 0,
  active: 0,
  indicator: "normal" as const,
  stats: {
    totalRequests: 0,
    totalTokens: 0,
    successRate: null,
    dailyRequests: [] as Array<{ date: string; count: number }>,
    avgDurationLastDay: null,
    durationLast24Hours: [] as Array<{ time: string; avgDuration: number }>,
  },
};

export function AccountsPage(): JSX.Element {
  const [searchParams] = useSearchParams<{ redirect?: string }>();
  const overviewQuery = createQuery(dataKeys.accountsOverview, () => api.accounts.overview());
  const customProvidersQuery = createQuery(dataKeys.customProviders, () => api.customProviders.list(), { defaultValue: [] });

  const customList = () => customProvidersQuery.data() ?? [];
  const summaries = () => overviewQuery.data()?.summaries ?? null;
  const pinnedProviders = createMemo(() => new Set(overviewQuery.data()?.pinnedProviders ?? []));

  const customProviderEntries = createMemo(() =>
    customList().map((provider) => ({ key: provider.slug, slug: provider.slug, label: provider.name }))
  );
  const providerEntries = createMemo(() => [
    ...PROVIDER_ACCOUNT_DEFINITIONS.map((definition) => ({
      key: definition.key as string,
      slug: definition.slug,
      label: definition.label,
    })),
    ...customProviderEntries(),
  ]);

  const sortedProviders = createMemo(() =>
    [...providerEntries()].sort((a, b) => {
      const aPinned = pinnedProviders().has(a.key) ? 0 : 1;
      const bPinned = pinnedProviders().has(b.key) ? 0 : 1;
      const aSummary = summaries()?.[a.key];
      const bSummary = summaries()?.[b.key];
      const aAvailability = (aSummary?.active ?? 0) > 0 ? "active" : "inactive";
      const bAvailability = (bSummary?.active ?? 0) > 0 ? "active" : "inactive";
      const aIndicator = aSummary?.indicator ?? "normal";
      const bIndicator = bSummary?.indicator ?? "normal";
      const aConnected = summaries()?.[a.key]?.connected ?? 0;
      const bConnected = summaries()?.[b.key]?.connected ?? 0;

      return (
        aPinned - bPinned ||
        PROVIDER_AVAILABILITY_ORDER[aAvailability] - PROVIDER_AVAILABILITY_ORDER[bAvailability] ||
        PROVIDER_STATUS_ORDER[aIndicator] - PROVIDER_STATUS_ORDER[bIndicator] ||
        bConnected - aConnected ||
        compareText(a.label, b.label)
      );
    })
  );

  function providerSummary(provider: string) {
    return summaries()?.[provider] ?? null;
  }

  function refreshOverview() {
    void overviewQuery.refresh();
    void customProvidersQuery.refresh();
  }

  const redirectTarget = createMemo(() => {
    const redirect = searchParams.redirect;
    return typeof redirect === "string" && redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : null;
  });

  if (typeof window !== "undefined") {
    const target = redirectTarget();
    if (target) window.location.replace(target);
  }

  return (
    <div class="space-y-6">
      <div class="web-header-divider">
        <div class="flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 class="inline-flex min-h-9 items-center gap-2 text-xl font-semibold">Provider Accounts</h2>
          <div class="flex w-full items-center sm:w-auto">
            <AddAccountDialog
              readonly={isAuditMode()}
              triggerClass="flex-1 sm:w-auto sm:flex-none"
              onConnected={refreshOverview}
              onCustomCreated={() => void customProvidersQuery.refresh()}
            />
          </div>
        </div>
      </div>

      <DataNotice error={overviewQuery.error()} />
      {summaries() ? (
        <div class="web-card-grid">
          {sortedProviders().map((provider) => (
            <ProviderOverviewCard
              provider={provider}
              summary={providerSummary(provider.key) ?? EMPTY_PROVIDER_SUMMARY}
              pinned={pinnedProviders().has(provider.key)}
              readonly={isAuditMode()}
              onToggled={() => void overviewQuery.refresh()}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default AccountsPage;
