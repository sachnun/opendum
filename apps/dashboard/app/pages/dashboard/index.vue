<script setup lang="ts">
import { PROVIDER_ACCOUNT_DEFINITIONS, type ProviderAccountKey } from "../../../lib/provider-accounts";

definePageMeta({ middleware: "auth", layout: "dashboard" });

const dashboardApi = useDashboardApi();

const dashboardInvalidation = useDashboardDataInvalidation();

const { data, error, pending, refresh } = await useAsyncData(dashboardInvalidation.keys.accountsOverview, () => dashboardApi.accounts.overview());

const summaries = computed(() => data.value?.summaries ?? null);
const pinnedProviders = computed(() => new Set(data.value?.pinnedProviders ?? []));
const totalConnectedAccounts = computed(() => Object.values(summaries.value ?? {}).reduce((total, summary) => total + summary.connected, 0));
const sortedProviders = computed(() => [...PROVIDER_ACCOUNT_DEFINITIONS].sort((a, b) => {
  const aPinned = pinnedProviders.value.has(a.key) ? 0 : 1;
  const bPinned = pinnedProviders.value.has(b.key) ? 0 : 1;
  const aConnected = summaries.value?.[a.key]?.connected ?? 0;
  const bConnected = summaries.value?.[b.key]?.connected ?? 0;

  return aPinned - bPinned || bConnected - aConnected || a.label.localeCompare(b.label);
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
          <AddAccountDialog trigger-class="flex-1 sm:w-auto sm:flex-none" @connected="refreshAccountsOverview" />
        </div>
      </div>
    </div>

    <DashboardDataNotice :error="error" />
    <UiSkeleton v-if="pending" class="h-96 rounded-xl" />
    <DashboardEmptyState
      v-else-if="summaries && totalConnectedAccounts === 0"
      title="No accounts connected"
      description="Connect your first provider account to start routing requests through Opendum."
      icon="i-lucide-user-plus"
    >
      <AddAccountDialog @connected="refreshAccountsOverview" />
    </DashboardEmptyState>
    <div v-else-if="summaries" class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
      <ProviderOverviewCard
        v-for="provider in sortedProviders"
        :key="provider.key"
        :provider="provider"
        :summary="providerSummary(provider.key)!"
        :pinned="pinnedProviders.has(provider.key)"
      />
    </div>
  </div>
</template>
