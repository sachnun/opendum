<script setup lang="ts">
import {
  PROVIDER_ACCOUNT_DEFINITIONS,
  type ProviderAccountKey,
} from "../../../../lib/provider-accounts";

definePageMeta({ middleware: "auth", layout: "dashboard" });

const dashboardApi = useDashboardApi();
type AccountSummaryData = Awaited<ReturnType<typeof dashboardApi.accounts.summary>>;

const PROVIDER_STATUS_ORDER = { error: 0, warning: 1, normal: 2 } as const;

const { data, error } = await useAsyncData("dashboard-accounts-summary", () => dashboardApi.accounts.summary());
const summaryData = computed<AccountSummaryData | null>(() => data.value ?? null);
const pinnedProviderSet = computed(() => new Set(summaryData.value!.pinnedProviders));
const providerCounts = computed(() => {
  if (!summaryData.value) return null;

  return PROVIDER_ACCOUNT_DEFINITIONS.reduce(
    (counts, provider) => {
      const summary = summaryData.value!.summaries[provider.key];
      if (summary.active > 0) counts.active += 1;
      if (summary.connected > 0) counts.connected += 1;
      return counts;
    },
    { active: 0, connected: 0 }
  );
});

function summaryFor(provider: ProviderAccountKey): AccountSummaryData["summaries"][ProviderAccountKey] {
  return summaryData.value!.summaries[provider];
}

function sortProvidersByStatus<T extends { key: ProviderAccountKey }>(providers: T[]): T[] {
  return [...providers].sort((a, b) => {
    const pinnedA = pinnedProviderSet.value.has(a.key) ? 0 : 1;
    const pinnedB = pinnedProviderSet.value.has(b.key) ? 0 : 1;
    return pinnedA - pinnedB
      || PROVIDER_STATUS_ORDER[summaryFor(a.key).indicator] - PROVIDER_STATUS_ORDER[summaryFor(b.key).indicator]
      || a.key.localeCompare(b.key);
  });
}

const sortedProviders = computed(() => summaryData.value ? sortProvidersByStatus(PROVIDER_ACCOUNT_DEFINITIONS) : []);

</script>

<template>
  <div class="space-y-6">
    <div class="dashboard-header-divider">
      <div class="flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 class="inline-flex min-h-9 items-center gap-2 text-xl font-semibold">
          Provider Accounts
          <UiBadge v-if="providerCounts && providerCounts.connected > 0" variant="outline" class="text-xs">
            {{ providerCounts.active }}/{{ providerCounts.connected }}
          </UiBadge>
        </h2>
        <div class="flex w-full items-center sm:w-auto">
          <AddAccountDialog trigger-class="flex-1 sm:w-auto sm:flex-none" />
        </div>
      </div>
    </div>

    <DashboardDataNotice :error="error" />
    <template v-if="summaryData">
      <section class="space-y-4 md:space-y-2">
        <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          <ProviderOverviewCard
            v-for="provider in sortedProviders"
            :key="provider.key"
            :provider="provider"
            :summary="summaryFor(provider.key)"
            :pinned="pinnedProviderSet.has(provider.key)"
          />
        </div>
      </section>

      <p v-if="PROVIDER_ACCOUNT_DEFINITIONS.length === 0" class="text-sm text-muted-foreground">
        No provider account definitions are configured.
      </p>
    </template>
  </div>
</template>
