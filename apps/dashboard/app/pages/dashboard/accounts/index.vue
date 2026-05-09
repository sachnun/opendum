<script setup lang="ts">
import {
  API_KEY_DEFINITIONS,
  OAUTH_DEFINITIONS,
  PROVIDER_ACCOUNT_DEFINITIONS,
  type ProviderAccountKey,
} from "../../../../lib/provider-accounts";

definePageMeta({ middleware: "auth", layout: "dashboard" });

const dashboardApi = useDashboardApi();

type AccountSummaryData = Awaited<ReturnType<typeof dashboardApi.accounts.summary>>;

const { data, error, pending, refresh } = await useAsyncData("dashboard-accounts-summary", () => dashboardApi.accounts.summary());
const summaryData = computed<AccountSummaryData | null>(() => data.value ?? null);
const pinnedProviderSet = computed(() => new Set(summaryData.value!.pinnedProviders));

function summaryFor(provider: ProviderAccountKey): AccountSummaryData["summaries"][ProviderAccountKey] {
  return summaryData.value!.summaries[provider];
}

function handlePinnedToggled() {
  refresh();
}
</script>

<template>
  <div class="space-y-6">
    <div class="sticky top-0 z-20 -mx-5 bg-background px-5 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <div class="border-b border-border pb-4 pt-3">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 class="text-xl font-semibold">Provider Accounts</h2>
          </div>
          <div class="flex w-full items-center gap-2 sm:w-auto">
            <AddAccountDialog trigger-class="flex-1 sm:w-auto sm:flex-none" @connected="refresh" />
          </div>
        </div>
      </div>
    </div>

    <DashboardDataNotice :error="error" />
    <template v-if="!pending && summaryData">
      <section class="space-y-4 md:space-y-2">
        <div class="space-y-1">
          <h3 class="text-base font-semibold">OAuth Provider Accounts</h3>
        </div>
        <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          <ProviderOverviewCard
            v-for="provider in OAUTH_DEFINITIONS"
            :key="provider.key"
            :provider="provider"
            :summary="summaryFor(provider.key)"
            :pinned="pinnedProviderSet.has(provider.key)"
            @toggled="handlePinnedToggled"
          />
        </div>
      </section>

      <section class="space-y-4 md:space-y-2">
        <div class="space-y-1">
          <h3 class="text-base font-semibold">API Key Provider Accounts</h3>
        </div>
        <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          <ProviderOverviewCard
            v-for="provider in API_KEY_DEFINITIONS"
            :key="provider.key"
            :provider="provider"
            :summary="summaryFor(provider.key)"
            :pinned="pinnedProviderSet.has(provider.key)"
            @toggled="handlePinnedToggled"
          />
        </div>
      </section>

      <p v-if="PROVIDER_ACCOUNT_DEFINITIONS.length === 0" class="text-sm text-muted-foreground">
        No provider account definitions are configured.
      </p>
    </template>
  </div>
</template>
