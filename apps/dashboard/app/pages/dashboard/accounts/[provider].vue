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
const activeAccountCount = computed(() => accounts.value.filter((account) => account.isActive).length);
const isLoadingAccounts = computed(() => pending.value || (!detailData.value && !error.value));
const pinnedProviders = computed(() => new Set(detailData.value?.pinnedProviders ?? []));
const supportedModels = computed(() => detailData.value?.supportedModels ?? []);
const disabledModelsByAccountId = computed(() => detailData.value?.disabledModelsByAccountId ?? {});

function handlePinnedToggled() {
  refresh();
}

function handleAccountConnected() {
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
              <UiBadge v-if="accounts.length > 0" variant="outline" class="text-xs tabular-nums">{{ activeAccountCount }}/{{ accounts.length }}</UiBadge>
            </h2>
          </div>
          <div class="flex w-full items-center gap-2 sm:w-auto">
            <AddAccountDialog
              v-if="providerMeta"
              :initial-provider="providerMeta.key"
              trigger-class="flex-1 sm:w-auto sm:flex-none"
              @connected="handleAccountConnected"
            />
          </div>
        </div>
      </div>
    </div>

    <DashboardDataNotice :error="error" />

    <DashboardEmptyState
      v-if="!isLoadingAccounts && accounts.length === 0"
      title="No accounts connected"
      :description="providerMeta?.emptyMessage ?? 'No accounts connected yet.'"
      icon="i-lucide-user-plus"
    >
      <div v-if="supportedModels.length" class="mx-auto max-w-2xl space-y-2 text-center">
        <p class="text-xs font-medium text-muted-foreground">Supported models ({{ supportedModels.length }}):</p>
        <div class="flex flex-wrap justify-center gap-1.5">
          <UiBadge
            v-for="model in supportedModels"
            :key="model"
            variant="secondary"
            class="text-xs font-normal"
          >
            {{ model }}
          </UiBadge>
        </div>
      </div>
      <AddAccountDialog
        v-if="providerMeta"
        :initial-provider="providerMeta.key"
        @connected="handleAccountConnected"
      />
    </DashboardEmptyState>
    <section v-else-if="accounts.length > 0" class="scroll-mt-24 space-y-4 md:space-y-2">
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
