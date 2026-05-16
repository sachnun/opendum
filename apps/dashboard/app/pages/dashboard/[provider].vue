<script setup lang="ts">
import type { ProviderAccountUpdateData, ProviderDetailData, QuotaGroupDisplay, QuotaProviderKey } from "../../../lib/dashboard-api-types";
import { BY_KEY, getProviderFromSlug, type ProviderAccountKey } from "../../../lib/provider-accounts";

definePageMeta({
  middleware: "auth",
  layout: "dashboard",
  validate: (route) => Boolean(getProviderFromSlug(String(route.params.provider))),
});

const route = useRoute();
const dashboardApi = useDashboardApi();
const { isAuditMode } = useDashboardAudit();
const dashboardInvalidation = useDashboardDataInvalidation();
const selectedProvider = computed<ProviderAccountKey>(() => getProviderFromSlug(String(route.params.provider))!);
const providerMeta = computed(() => BY_KEY[selectedProvider.value]);

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
const QUOTA_AUTO_LOAD_DELAY_MS = 400;
const ACCOUNT_STATUS_ORDER: Record<string, number> = { failed: 0, degraded: 1, half_open: 2, active: 3 };
const FREE_TIER_VALUES = new Set(["", "free", "free-tier", "guest", "unknown"]);

const { data, error, pending, refresh } = await useAsyncData(
  () => `dashboard-accounts-detail-${selectedProvider.value}`,
  () => dashboardApi.accounts.byProviderDetailed({ provider: selectedProvider.value }),
  { server: false, watch: [selectedProvider] }
);

const detailData = computed<ProviderDetailData | null>(() => data.value ?? null);
const accountDisplayOrder = ref<Record<string, number>>({});
const highlightedAccountIds = ref<Set<string>>(new Set());
const accountCardRefs = ref<Array<{ accountId?: string; $el?: Element } | Element>>([]);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
const accounts = computed(() => {
  const currentAccounts = detailData.value?.accounts ?? [];
  return [...currentAccounts].sort((a, b) => {
    const aOrder = accountDisplayOrder.value[a.id];
    const bOrder = accountDisplayOrder.value[b.id];

    if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
    if (aOrder !== undefined) return -1;
    if (bOrder !== undefined) return 1;

    return compareAccounts(a, b);
  });
});
const activeAccountCount = computed(() => accounts.value.filter((account) => account.isActive).length);
const isLoadingAccounts = computed(() => pending.value || (!detailData.value && !error.value));
const pinnedProviders = computed(() => new Set(detailData.value?.pinnedProviders ?? []));
const supportedModels = computed(() => detailData.value?.supportedModels ?? []);
const disabledModelsByAccountId = computed(() => detailData.value?.disabledModelsByAccountId ?? {});
const modelHealthByAccountId = computed(() => detailData.value?.modelHealthByAccountId ?? {});
const supportsProviderQuota = computed(() => QUOTA_PROVIDERS.has(selectedProvider.value));
const selectedAccountId = computed(() => decodeAccountHash(route.hash));
type QuotaAccountState = { provider: string; isActive: boolean };

watch(
  detailData,
  (value) => {
    if (!value) return;

    const orderedAccounts = [...value.accounts].sort(compareAccounts);
    const currentOrder = accountDisplayOrder.value;
    if (Object.keys(currentOrder).length === 0) {
      accountDisplayOrder.value = Object.fromEntries(
        orderedAccounts.map((account, index) => [account.id, index])
      );
      return;
    }

    const knownAccountIds = new Set(Object.keys(currentOrder));
    const newAccounts = orderedAccounts.filter((account) => !knownAccountIds.has(account.id));
    if (newAccounts.length === 0) return;
    if (newAccounts.length === orderedAccounts.length) {
      accountDisplayOrder.value = Object.fromEntries(
        orderedAccounts.map((account, index) => [account.id, index])
      );
      highlightedAccountIds.value = new Set();
      return;
    }

    accountDisplayOrder.value = Object.fromEntries([
      ...newAccounts.map((account, index) => [account.id, index] as const),
      ...Object.entries(currentOrder).map(([accountId, order]) => [accountId, order + newAccounts.length] as const),
    ]);

    highlightedAccountIds.value = new Set(newAccounts.map((account) => account.id));
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      highlightedAccountIds.value = new Set();
      highlightTimer = null;
    }, 5000);
  },
  { immediate: true }
);

watch(selectedProvider, () => {
  accountDisplayOrder.value = {};
  highlightedAccountIds.value = new Set();
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
});

watch(
  [accounts, selectedAccountId],
  async ([currentAccounts, accountId]) => {
    if (!accountId || !currentAccounts.some((account) => account.id === accountId)) return;

    highlightedAccountIds.value = new Set([accountId]);
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      highlightedAccountIds.value = new Set();
      highlightTimer = null;
    }, 5000);

    await nextTick();
    const accountCard = accountCardRefs.value.find((card) => {
      if (card instanceof Element) return card.getAttribute("data-account-id") === accountId;
      return card.accountId === accountId || card.$el?.getAttribute("data-account-id") === accountId;
    });
    const accountElement = accountCard instanceof Element ? accountCard : accountCard?.$el;
    accountElement?.scrollIntoView({ block: "center", behavior: "smooth" });
  },
  { immediate: true }
);

const quotaCapableAccounts = computed(() => accounts.value.filter((account) => account.provider === selectedProvider.value && toQuotaProvider(account.provider)));
const activeQuotaAccounts = computed(() => quotaCapableAccounts.value.filter((account) => account.isActive));
let previousQuotaAccountKeys = new Set<string>();
let previousQuotaAccountStates = new Map<string, QuotaAccountState>();
let previousQuotaProvider: ProviderAccountKey | null = null;
const {
  quotaByAccountId,
  quotaErrorByAccountId,
  quotaLoadingByAccountId,
  cancelQuotaQueue,
  hydrateQuotaCache,
  loadAccountQuota,
  pruneQuotaState,
  runQuotaQueue,
} = useAccountQuotaMonitor({ accounts, quotaCapableAccounts, toQuotaProvider });

onBeforeUnmount(() => {
  if (highlightTimer) clearTimeout(highlightTimer);
  cancelQuotaQueue();
});
const quotaSummaryGroups = computed<QuotaSummaryGroup[]>(() => {
  const groups = new Map<string, QuotaSummaryGroup>();

  for (const account of activeQuotaAccounts.value) {
    const quota = quotaByAccountId.value[account.id];
    if (quota?.status !== "success") continue;

    for (const group of quota.groups) {
      if (![group.remainingRequests, group.maxRequests, group.usedRequests].every(Number.isFinite) || group.maxRequests <= 0) continue;

      const groupKey = `${group.name}:${group.displayName}`;
      const current = groups.get(groupKey) ?? {
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
      groups.set(groupKey, current);
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

function isTierAboveFree(tier: string | null): boolean {
  return !FREE_TIER_VALUES.has(tier?.trim().toLowerCase() ?? "");
}

function getAccountSortGroup(account: Account): number {
  if (!account.isActive) return 2;
  return isTierAboveFree(account.tier) ? 0 : 1;
}

function toTimeMs(value: string | Date | null | undefined): number {
  if (!value) return 0;

  const timeMs = new Date(value).getTime();
  return Number.isNaN(timeMs) ? 0 : timeMs;
}

function compareAccounts(a: Account, b: Account): number {
  return getAccountSortGroup(a) - getAccountSortGroup(b)
    || toTimeMs(b.lastErrorAt) - toTimeMs(a.lastErrorAt)
    || (ACCOUNT_STATUS_ORDER[a.status] ?? ACCOUNT_STATUS_ORDER.active) - (ACCOUNT_STATUS_ORDER[b.status] ?? ACCOUNT_STATUS_ORDER.active);
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
  () => `${selectedProvider.value}|${accounts.value.map((account) => `${account.id}:${account.provider}:${account.isActive}`).join("|")}`,
  (_, __, onCleanup) => {
    const providerChanged = previousQuotaProvider !== selectedProvider.value;
    const currentQuotaAccountKeys = new Set(quotaCapableAccounts.value.map((account) => `${account.id}:${account.provider}`));
    const currentQuotaAccountStates = new Map(quotaCapableAccounts.value.map((account) => [account.id, { provider: account.provider, isActive: account.isActive }]));
    const newQuotaAccounts = quotaCapableAccounts.value.filter((account) => !previousQuotaAccountKeys.has(`${account.id}:${account.provider}`));
    const reenabledAccountsWithoutQuota = quotaCapableAccounts.value.filter((account) => {
      const previousState = previousQuotaAccountStates.get(account.id);
      return previousState?.provider === account.provider && previousState.isActive === false && account.isActive && !quotaByAccountId.value[account.id];
    });
    const shouldRefreshExisting = previousQuotaAccountKeys.size === 0 || providerChanged;
    const accountsToFetch = shouldRefreshExisting
      ? quotaCapableAccounts.value
      : newQuotaAccounts.length > 0
        ? newQuotaAccounts
        : reenabledAccountsWithoutQuota;

    pruneQuotaState();
    cancelQuotaQueue();
    void hydrateQuotaCache();
    previousQuotaAccountKeys = currentQuotaAccountKeys;
    previousQuotaAccountStates = currentQuotaAccountStates;
    previousQuotaProvider = selectedProvider.value;

    if (accountsToFetch.length === 0) return;

    let cancelled = false;
    const quotaLoadTimer = setTimeout(() => {
      if (!cancelled) void runQuotaQueue(accountsToFetch, shouldRefreshExisting);
    }, QUOTA_AUTO_LOAD_DELAY_MS);

    onCleanup(() => {
      cancelled = true;
      clearTimeout(quotaLoadTimer);
      cancelQuotaQueue();
    });
  },
  { immediate: true }
);

function handleAccountRenamed(account: ProviderAccountUpdateData) {
  dashboardInvalidation.patchProviderAccount(selectedProvider.value, account.id, { name: account.name });
  dashboardInvalidation.patchAccountNameInOptions(account.id, account.name);
}

function handleAccountActiveUpdated(account: ProviderAccountUpdateData) {
  dashboardInvalidation.patchProviderAccount(selectedProvider.value, account.id, account);
  void dashboardInvalidation.invalidateAccountOverview();
  dashboardInvalidation.clearAccountDependentOptions();
  dashboardInvalidation.clearModelAvailability();
}

function handleAccountDeleted(accountId: string) {
  dashboardInvalidation.removeProviderAccount(selectedProvider.value, accountId);
  void dashboardInvalidation.invalidateAccountOverview();
  dashboardInvalidation.clearAccountDependentOptions();
  dashboardInvalidation.clearModelAvailability();
}

function handleAccountErrorsResolved() {
  void refresh();
  void dashboardInvalidation.invalidateAccountOverview();
}

function decodeAccountHash(hash: string): string | null {
  const accountId = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!accountId) return null;

  try {
    return decodeURIComponent(accountId);
  } catch {
    return accountId;
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="dashboard-header-divider">
      <div class="flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 class="inline-flex min-h-9 items-center gap-2 text-xl font-semibold">
          <ProviderPinButton
            v-if="providerMeta && !isAuditMode"
            :provider-key="providerMeta.key"
            :pinned="pinnedProviders.has(providerMeta.key)"
          />
          {{ providerMeta?.label ?? selectedProvider.replaceAll('_', ' ') }}
          <UiBadge v-if="accounts.length > 0" variant="outline" class="text-xs">{{ activeAccountCount }}/{{ accounts.length }}</UiBadge>
        </h2>
        <div class="flex w-full items-center sm:w-auto">
          <AddAccountDialog
            v-if="providerMeta && !isAuditMode"
            :initial-provider="providerMeta.key"
            trigger-class="flex-1 sm:w-auto sm:flex-none"
          />
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
      <div v-if="supportsProviderQuota" class="space-y-2 pb-2">
        <div v-if="quotaSummaryGroups.length > 0" class="grid gap-x-6 gap-y-3 md:grid-cols-2 xl:grid-cols-3">
          <div v-for="group in quotaSummaryGroups" :key="group.name" class="space-y-1.5">
            <div class="flex items-start justify-between gap-2 text-xs">
              <div class="flex min-w-0 items-center gap-1.5">
                <p class="truncate font-medium text-foreground">{{ group.displayName }}</p>
                <span class="shrink-0 text-[10px] text-muted-foreground">{{ group.accounts }} account{{ group.accounts === 1 ? '' : 's' }}</span>
              </div>
              <span class="font-mono text-xs text-muted-foreground">{{ quotaPercentRemaining(group) }}%</span>
            </div>
            <div class="h-1.5 overflow-hidden rounded-full bg-muted">
              <div class="h-full transition-all duration-300" :class="quotaBarColor(group)" :style="{ width: `${quotaPercentRemaining(group)}%` }" />
            </div>
          </div>
        </div>
        <div v-else-if="activeQuotaAccounts.length > 0" class="grid gap-x-6 gap-y-3 md:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
          <div v-for="index in Math.min(activeQuotaAccounts.length, 3)" :key="index" class="space-y-1.5">
            <div class="flex items-center justify-between gap-2">
              <div class="flex min-w-0 items-center gap-1.5">
                <UiSkeleton class="h-3 w-24" />
                <UiSkeleton class="h-2.5 w-14" />
              </div>
              <UiSkeleton class="h-3 w-8" />
            </div>
            <div class="h-1.5 overflow-hidden rounded-full bg-muted">
              <UiSkeleton class="h-full w-4/5 rounded-full" />
            </div>
          </div>
        </div>
      </div>

      <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
        <ProviderAccountCard
          v-for="account in accounts"
          :id="account.id"
          :key="account.id"
          ref="accountCardRefs"
          :account="account"
          :data-account-id="account.id"
          :show-tier="providerMeta?.showTier"
          :supported-models="supportedModels"
          :disabled-models="disabledModelsByAccountId[account.id] ?? []"
          :model-health="modelHealthByAccountId[account.id] ?? {}"
          :quota-info="quotaByAccountId[account.id] ?? null"
          :quota-error="quotaErrorByAccountId[account.id] ?? null"
          :is-quota-loading="Boolean(quotaLoadingByAccountId[account.id])"
          :highlight="highlightedAccountIds.has(account.id)"
          :readonly="isAuditMode"
          @renamed="handleAccountRenamed"
          @active-updated="handleAccountActiveUpdated"
          @temporarily-disabled="handleAccountActiveUpdated"
          @deleted="handleAccountDeleted"
          @errors-resolved="handleAccountErrorsResolved"
          @refresh-quota="handleQuotaRefresh"
        />
      </div>
    </section>
  </div>
</template>
