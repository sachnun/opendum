<script setup lang="ts">
import { BY_KEY, getProviderFromSlug, type ProviderAccountKey } from "../../../../lib/provider-accounts";

definePageMeta({ middleware: "auth", layout: "dashboard" });

const route = useRoute();
const dashboardApi = useDashboardApi();
const selectedProvider = computed(() => getProviderFromSlug(String(route.params.provider)) ?? String(route.params.provider));
const providerMeta = computed(() => selectedProvider.value in BY_KEY ? BY_KEY[selectedProvider.value as ProviderAccountKey] : null);

type ProviderDetailData = Awaited<ReturnType<typeof dashboardApi.accounts.byProviderDetailed>>;

const { data, error, pending, refresh } = await useAsyncData(
  () => `dashboard-accounts-detail-${selectedProvider.value}`,
  () => dashboardApi.accounts.byProviderDetailed({ provider: selectedProvider.value }),
  { server: false, watch: [selectedProvider] }
);

const detailData = computed<ProviderDetailData | null>(() => data.value ?? null);
const accounts = computed(() => detailData.value?.accounts ?? []);
const isLoadingAccounts = computed(() => pending.value || (!detailData.value && !error.value));
const pinnedProviders = computed(() => new Set(detailData.value?.pinnedProviders ?? []));
const supportedModels = computed(() => detailData.value?.supportedModels ?? []);
const disabledModelsByAccountId = computed(() => detailData.value?.disabledModelsByAccountId ?? {});

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
            <h2 class="inline-flex items-center gap-2 text-xl font-semibold">
              <ProviderPinButton
                v-if="providerMeta"
                :provider-key="providerMeta.key"
                :pinned="pinnedProviders.has(providerMeta.key)"
                @toggled="handlePinnedToggled"
              />
              {{ providerMeta?.label ?? selectedProvider.replaceAll('_', ' ') }}
            </h2>
          </div>
          <div class="flex w-full items-center gap-2 sm:w-auto">
            <AddAccountDialog
              v-if="providerMeta"
              :initial-provider="providerMeta.key"
              trigger-class="flex-1 sm:w-auto sm:flex-none"
              @connected="refresh"
            />
          </div>
        </div>
      </div>
    </div>

    <DashboardDataNotice :error="error" />

    <section v-if="isLoadingAccounts" class="space-y-4 md:space-y-2" aria-label="Loading provider accounts">
      <div class="flex items-center gap-2">
        <UiSkeleton class="h-6 w-32" />
        <UiSkeleton class="h-5 w-20 rounded-full" />
      </div>
      <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
        <UiCard v-for="index in 3" :key="index" class="flex h-full flex-col bg-card">
          <UiCardHeader class="space-y-3 pb-2">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1 space-y-2">
                <UiSkeleton class="h-5 w-40" />
                <UiSkeleton class="h-4 w-56 max-w-full" />
              </div>
              <UiSkeleton class="h-5 w-16 rounded-full" />
            </div>
          </UiCardHeader>
          <UiCardContent class="flex flex-1 flex-col">
            <div class="flex-1 space-y-3 text-sm">
              <div class="rounded-md border border-border/70 bg-muted/20 p-2.5">
                <div class="mb-2 flex items-center justify-between">
                  <UiSkeleton class="h-3 w-12" />
                  <UiSkeleton class="h-3 w-14" />
                </div>
                <div class="mb-2 grid grid-cols-3 gap-1.5">
                  <UiSkeleton class="h-12 rounded" />
                  <UiSkeleton class="h-12 rounded" />
                  <UiSkeleton class="h-12 rounded" />
                </div>
                <UiSkeleton class="mb-2 h-10 rounded" />
                <UiSkeleton class="h-8 rounded" />
              </div>
              <UiSkeleton class="h-4 w-full" />
              <UiSkeleton class="h-4 w-full" />
              <UiSkeleton class="h-4 w-3/4" />
              <div class="border-t pt-3">
                <UiSkeleton class="h-12 rounded" />
              </div>
            </div>
            <div class="mt-4 flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <UiSkeleton class="h-8 w-9" />
                <UiSkeleton class="h-8 w-9" />
                <UiSkeleton class="h-8 w-9" />
              </div>
              <UiSkeleton class="h-5 w-16 rounded-full" />
            </div>
          </UiCardContent>
        </UiCard>
      </div>
    </section>
    <DashboardEmptyState
      v-else-if="accounts.length === 0"
      title="No accounts connected"
      :description="providerMeta?.emptyMessage ?? 'No accounts connected yet.'"
      icon="i-lucide-user-plus"
    >
      <AddAccountDialog
        v-if="providerMeta"
        :initial-provider="providerMeta.key"
        @connected="refresh"
      />
    </DashboardEmptyState>
    <section v-else class="scroll-mt-24 space-y-4 md:space-y-2">
      <div class="flex items-center gap-2">
        <h3 class="text-base font-semibold md:text-lg">{{ providerMeta?.label ?? selectedProvider }}</h3>
        <UiBadge variant="outline" class="text-xs">{{ accounts.length }} connected</UiBadge>
      </div>
      <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
        <ProviderAccountCard
          v-for="account in accounts"
          :key="account.id"
          :account="account"
          :show-tier="providerMeta?.showTier"
          :supported-models="supportedModels"
          :disabled-models="disabledModelsByAccountId[account.id] ?? []"
          @changed="refresh"
        />
      </div>
    </section>
  </div>
</template>
