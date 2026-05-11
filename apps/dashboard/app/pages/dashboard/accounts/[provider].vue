<script setup lang="ts">
import type { AccountQuotaInfo, ProviderDetailData, QuotaGroupDisplay, QuotaProviderKey } from "../../../../lib/dashboard-api-types";
import { BY_KEY, getProviderFromSlug, type ProviderAccountKey } from "../../../../lib/provider-accounts";

definePageMeta({ middleware: "auth", layout: "dashboard" });

const route = useRoute();
const dashboardApi = useDashboardApi();
const selectedProvider = computed(() => getProviderFromSlug(String(route.params.provider)) ?? String(route.params.provider));
const providerMeta = computed(() => selectedProvider.value in BY_KEY ? BY_KEY[selectedProvider.value as ProviderAccountKey] : null);

type Account = ProviderDetailData["accounts"][number];
type QuotaSummaryGroup = Pick<QuotaGroupDisplay, "name" | "displayName"> & {
  remainingRequests: number;
  maxRequests: number;
  usedRequests: number;
  remainingFraction: number;
  percentUsed: number;
  accounts: number;
};

const QUOTA_PROVIDERS = new Set<string>(["antigravity", "copilot", "codex", "gemini_cli", "kiro", "openrouter"]);

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
const supportsProviderQuota = computed(() => QUOTA_PROVIDERS.has(selectedProvider.value));
const quotaByAccountId = ref<Record<string, AccountQuotaInfo>>({});
const quotaErrorByAccountId = ref<Record<string, string>>({});
const quotaLoadingByAccountId = ref<Record<string, boolean>>({});
let quotaQueueRunId = 0;

const quotaCapableAccounts = computed(() => accounts.value.filter((account) => toQuotaProvider(account.provider)));
const activeQuotaAccounts = computed(() => quotaCapableAccounts.value.filter((account) => account.isActive));
const quotaSummaryGroups = computed<QuotaSummaryGroup[]>(() => {
  const groups = new Map<string, QuotaSummaryGroup>();

  for (const account of activeQuotaAccounts.value) {
    const quota = quotaByAccountId.value[account.id];
    if (quota?.status !== "success") continue;

    for (const group of quota.groups) {
      if (![group.remainingRequests, group.maxRequests, group.usedRequests].every(Number.isFinite) || group.maxRequests <= 0) continue;

      const current = groups.get(group.name) ?? {
        name: group.name,
        displayName: group.displayName,
        remainingRequests: 0,
        maxRequests: 0,
        usedRequests: 0,
        remainingFraction: 0,
        percentUsed: 0,
        accounts: 0,
      };

      current.remainingRequests += group.remainingRequests;
      current.maxRequests += group.maxRequests;
      current.usedRequests += group.usedRequests;
      current.accounts += 1;
      groups.set(group.name, current);
    }
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      remainingFraction: group.maxRequests > 0 ? Math.max(0, Math.min(1, group.remainingRequests / group.maxRequests)) : 0,
      percentUsed: group.maxRequests > 0 ? Math.round(Math.max(0, Math.min(100, (group.usedRequests / group.maxRequests) * 100))) : 0,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
});

function toQuotaProvider(provider: string): QuotaProviderKey | null {
  return QUOTA_PROVIDERS.has(provider) ? provider as QuotaProviderKey : null;
}

function setQuotaLoading(accountId: string, loading: boolean) {
  quotaLoadingByAccountId.value = loading
    ? { ...quotaLoadingByAccountId.value, [accountId]: true }
    : Object.fromEntries(Object.entries(quotaLoadingByAccountId.value).filter(([key]) => key !== accountId));
}

function pruneQuotaState() {
  const accountIds = new Set(accounts.value.map((account) => account.id));
  quotaByAccountId.value = Object.fromEntries(Object.entries(quotaByAccountId.value).filter(([accountId]) => accountIds.has(accountId)));
  quotaErrorByAccountId.value = Object.fromEntries(Object.entries(quotaErrorByAccountId.value).filter(([accountId]) => accountIds.has(accountId)));
  quotaLoadingByAccountId.value = Object.fromEntries(Object.entries(quotaLoadingByAccountId.value).filter(([accountId]) => accountIds.has(accountId)));
}

async function loadAccountQuota(account: Account, forceRefresh = false, runId?: number) {
  const provider = toQuotaProvider(account.provider);
  if (!provider || quotaLoadingByAccountId.value[account.id]) return;
  if (!forceRefresh && (quotaByAccountId.value[account.id] || quotaErrorByAccountId.value[account.id])) return;

  setQuotaLoading(account.id, true);
  quotaErrorByAccountId.value = { ...quotaErrorByAccountId.value, [account.id]: "" };

  try {
    const result = await dashboardApi.accounts.quota({ provider, accountId: account.id, forceRefresh });
    if (runId !== undefined && runId !== quotaQueueRunId) return;
    if (!result.success) throw new Error(result.error);

    quotaByAccountId.value = { ...quotaByAccountId.value, [account.id]: result.data };
    quotaErrorByAccountId.value = Object.fromEntries(Object.entries(quotaErrorByAccountId.value).filter(([accountId]) => accountId !== account.id));
  } catch (error) {
    if (runId !== undefined && runId !== quotaQueueRunId) return;
    const message = error instanceof Error ? error.message : "Failed to fetch quota data";
    quotaErrorByAccountId.value = { ...quotaErrorByAccountId.value, [account.id]: message };
  } finally {
    setQuotaLoading(account.id, false);
  }
}

async function runQuotaQueue() {
  const runId = ++quotaQueueRunId;
  const enabledFirstAccounts = [
    ...quotaCapableAccounts.value.filter((account) => account.isActive),
    ...quotaCapableAccounts.value.filter((account) => !account.isActive),
  ];

  for (const account of enabledFirstAccounts) {
    if (runId !== quotaQueueRunId) return;
    if (quotaLoadingByAccountId.value[account.id]) {
      while (quotaLoadingByAccountId.value[account.id] && runId === quotaQueueRunId) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (runId !== quotaQueueRunId) return;
    }
    await loadAccountQuota(account, false, runId);
  }
}

function quotaPercentRemaining(group: QuotaSummaryGroup): number {
  return Math.max(0, Math.min(100, Math.round(group.remainingFraction * 100)));
}

function quotaBarColor(group: QuotaSummaryGroup): string {
  const percentRemaining = quotaPercentRemaining(group);
  if (percentRemaining <= 10) return "bg-red-500";
  if (percentRemaining <= 25) return "bg-orange-500";
  if (percentRemaining <= 50) return "bg-yellow-500";
  return "bg-green-500";
}

function handleQuotaRefresh(accountId: string) {
  const account = accounts.value.find((account) => account.id === accountId);
  if (account) loadAccountQuota(account, true);
}

watch(
  () => accounts.value.map((account) => `${account.id}:${account.provider}:${account.isActive}`).join("|"),
  () => {
    pruneQuotaState();
    runQuotaQueue();
  },
  { immediate: true }
);

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

    <section v-if="!isLoadingAccounts && accounts.length === 0" class="scroll-mt-24 space-y-4 md:space-y-2">
      <div class="space-y-3 pt-1">
        <p class="text-sm text-muted-foreground">{{ providerMeta?.emptyMessage ?? 'No accounts connected yet.' }}</p>
        <div v-if="supportedModels.length" class="space-y-2">
          <p class="text-xs font-medium text-muted-foreground">Supported models ({{ supportedModels.length }}):</p>
          <div class="flex flex-wrap gap-1.5">
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
      </div>
    </section>
    <section v-else-if="accounts.length > 0" class="scroll-mt-24 space-y-4 md:space-y-2">
      <div v-if="supportsProviderQuota" class="space-y-2">
        <div class="flex gap-2">
          <UiIcon name="i-lucide-speedometer" class="size-4 text-muted-foreground" />
        </div>

        <div v-if="quotaSummaryGroups.length > 0" class="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          <div v-for="group in quotaSummaryGroups" :key="group.name" class="rounded-md border border-border/70 bg-muted/20 p-3">
            <div class="flex items-start justify-between gap-2 text-xs">
              <div class="flex min-w-0 items-center gap-1.5">
                <p class="truncate font-medium text-foreground">{{ group.displayName }}</p>
                <span class="shrink-0 text-[10px] text-muted-foreground">{{ group.accounts }} account{{ group.accounts === 1 ? '' : 's' }}</span>
              </div>
              <span class="font-mono text-xs text-muted-foreground">{{ quotaPercentRemaining(group) }}%</span>
            </div>
            <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div class="h-full transition-all duration-300" :class="quotaBarColor(group)" :style="{ width: `${quotaPercentRemaining(group)}%` }" />
            </div>
          </div>
        </div>

        <p v-else class="rounded-md border border-dashed border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {{ activeQuotaAccounts.length === 0 ? 'No enabled accounts support quota summary.' : 'Loading quota summary from enabled accounts...' }}
        </p>
      </div>

      <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
        <ProviderAccountCard
          v-for="account in accounts"
          :key="account.id"
          :account="account"
          :show-tier="providerMeta?.showTier"
          :supported-models="supportedModels"
          :disabled-models="disabledModelsByAccountId[account.id] ?? []"
          :quota-info="quotaByAccountId[account.id] ?? null"
          :quota-error="quotaErrorByAccountId[account.id] ?? null"
          :is-quota-loading="Boolean(quotaLoadingByAccountId[account.id])"
          @changed="refresh"
          @refresh-quota="handleQuotaRefresh"
        />
      </div>
    </section>
  </div>
</template>
