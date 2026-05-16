<script setup lang="ts">
import { PROVIDER_ACCOUNT_DEFINITIONS, type ProviderAccountKey } from "../../../lib/provider-accounts";

definePageMeta({ middleware: "auth", layout: "dashboard" });

const dashboardApi = useDashboardApi();
const { isAuditMode } = useDashboardAudit();

const dashboardInvalidation = useDashboardDataInvalidation();

const { data, error, pending, refresh } = await useAsyncData(dashboardInvalidation.keys.accountsOverview, () => dashboardApi.accounts.overview());

const summaries = computed(() => data.value?.summaries ?? null);
const isInitialLoading = computed(() => pending.value && !data.value);
const pinnedProviders = computed(() => new Set(data.value?.pinnedProviders ?? []));
const providerAvailabilityOrder = { active: 0, inactive: 1 } as const;
const providerStatusOrder = { error: 0, warning: 1, normal: 2 } as const;
const sortedProviders = computed(() => [...PROVIDER_ACCOUNT_DEFINITIONS].sort((a, b) => {
  const aPinned = pinnedProviders.value.has(a.key) ? 0 : 1;
  const bPinned = pinnedProviders.value.has(b.key) ? 0 : 1;
  const aSummary = summaries.value?.[a.key];
  const bSummary = summaries.value?.[b.key];
  const aAvailability = (aSummary?.active ?? 0) > 0 ? "active" : "inactive";
  const bAvailability = (bSummary?.active ?? 0) > 0 ? "active" : "inactive";
  const aIndicator = aSummary?.indicator ?? "normal";
  const bIndicator = bSummary?.indicator ?? "normal";
  const aConnected = summaries.value?.[a.key]?.connected ?? 0;
  const bConnected = summaries.value?.[b.key]?.connected ?? 0;

  return aPinned - bPinned
    || providerAvailabilityOrder[aAvailability] - providerAvailabilityOrder[bAvailability]
    || providerStatusOrder[aIndicator] - providerStatusOrder[bIndicator]
    || bConnected - aConnected
    || a.label.localeCompare(b.label);
}));

function providerSummary(provider: ProviderAccountKey) {
  return summaries.value?.[provider] ?? null;
}

function refreshAccountsOverview() {
  void refresh();
}
</script>

<template>
  <div class="space-y-6">
    <div class="dashboard-header-divider">
      <div class="flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 class="inline-flex min-h-9 items-center gap-2 text-xl font-semibold">
          Provider Accounts
        </h2>
        <div class="flex w-full items-center sm:w-auto">
          <AddAccountDialog :readonly="isAuditMode" trigger-class="flex-1 sm:w-auto sm:flex-none" @connected="refreshAccountsOverview" />
        </div>
      </div>
    </div>

    <DashboardDataNotice :error="error" />
    <UiSkeleton v-if="isInitialLoading" class="h-96 rounded-xl" />
    <div v-else-if="summaries" class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
      <ProviderOverviewCard
        v-for="provider in sortedProviders"
        :key="provider.key"
        :provider="provider"
        :summary="providerSummary(provider.key)!"
        :pinned="pinnedProviders.has(provider.key)"
        :readonly="isAuditMode"
      />
    </div>
  </div>
</template>
