<script setup lang="ts">
import { useSession } from "../../lib/auth-client";
import { PROVIDER_ACCOUNT_DEFINITIONS } from "../../lib/provider-accounts";

definePageMeta({ middleware: "auth", layout: false });

const route = useRoute();
const { data: session } = await useSession(useFetch);
const isAuthenticated = computed(() => Boolean(session.value?.user));

const redirectTarget = computed(() => {
  const redirect = Array.isArray(route.query.redirect) ? route.query.redirect[0] : route.query.redirect;
  return typeof redirect === "string" && redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/";
});

if (import.meta.client && session.value?.user && redirectTarget.value !== "/") {
  await navigateTo(redirectTarget.value);
}

const api = useApi();
const { isAuditMode } = useAudit();

const { data, error, refresh } = useCachedData(dataKeys.accountsOverview, () => api.accounts.overview());
const { data: customProviders, refresh: refreshCustomProviders } = useCachedData(dataKeys.customProviders, () => api.customProviders.list());

const customList = computed(() => customProviders.value ?? []);
const summaries = computed(() => data.value?.summaries ?? null);
const pinnedProviders = computed(() => new Set(data.value?.pinnedProviders ?? []));
const providerAvailabilityOrder = { active: 0, inactive: 1 } as const;
const providerStatusOrder = { error: 0, warning: 1, normal: 2 } as const;
const customProviderEntries = computed(() => customList.value.map((provider) => ({ key: provider.slug, slug: provider.slug, label: provider.name })));
const providerEntries = computed(() => [
  ...PROVIDER_ACCOUNT_DEFINITIONS.map((definition) => ({ key: definition.key as string, slug: definition.slug, label: definition.label })),
  ...customProviderEntries.value,
]);
const sortedProviders = computed(() => [...providerEntries.value].sort((a, b) => {
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

function providerSummary(provider: string) {
  return summaries.value?.[provider] ?? null;
}

const emptyProviderSummary = {
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

function refreshAccountsOverview() {
  void refresh();
  void refreshCustomProviders();
}
</script>

<template>
  <NuxtLayout v-if="isAuthenticated" name="dashboard">
    <div class="space-y-6">
      <div class="dashboard-header-divider">
        <div class="flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 class="inline-flex min-h-9 items-center gap-2 text-xl font-semibold">
            Provider Accounts
          </h2>
          <div class="flex w-full items-center sm:w-auto">
            <AddAccountDialog :readonly="isAuditMode" trigger-class="flex-1 sm:w-auto sm:flex-none" @connected="refreshAccountsOverview" @custom-created="() => refreshCustomProviders()" />
          </div>
        </div>
      </div>

      <DataNotice :error="error" />
      <div v-if="summaries" class="dashboard-card-grid">
        <ProviderOverviewCard
          v-for="provider in sortedProviders"
          :key="provider.key"
          :provider="provider"
          :summary="providerSummary(provider.key) ?? emptyProviderSummary"
          :pinned="pinnedProviders.has(provider.key)"
          :readonly="isAuditMode"
        />
      </div>
    </div>
  </NuxtLayout>
  <LoginScreen v-else />
</template>
