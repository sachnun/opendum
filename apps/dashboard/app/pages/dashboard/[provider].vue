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
const PROVIDER_DETAIL_REFRESH_MS = 30_000;

const { data, error, pending, refresh } = await useAsyncData(
  () => `dashboard-accounts-detail-${selectedProvider.value}`,
  () => dashboardApi.accounts.byProviderDetailed({ provider: selectedProvider.value }),
  { server: false, watch: [selectedProvider] }
);

const detailData = computed<ProviderDetailData | null>(() => data.value ?? null);
const highlightedAccountIds = ref<Set<string>>(new Set());
const promotedAccountIds = ref<Set<string>>(new Set());
const accountCardRefs = ref<Array<{ accountId?: string; $el?: Element } | Element>>([]);
const visibleAccountIds = ref<Set<string>>(new Set());
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
let accountVisibilityObserver: IntersectionObserver | null = null;
let providerDetailRefreshTimer: ReturnType<typeof setInterval> | null = null;
let providerDetailRefreshInFlight: Promise<void> | null = null;
let providerDetailRefreshQueued = false;
let providerDetailRefreshQueuedShouldRefreshQuota = false;
let providerQuotaRefreshInFlight: Promise<void> | null = null;
let shouldPromoteNextNewAccount = false;
const accounts = computed(() => {
  const currentAccounts = detailData.value?.accounts ?? [];
  return [...currentAccounts].sort(compareAccounts);
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

async function refreshProviderDetailOnce(options: { refreshQuota?: boolean } = {}) {
  const shouldRefreshQuota = options.refreshQuota ?? true;
  if (pending.value || providerDetailRefreshInFlight) {
    providerDetailRefreshQueued = true;
    providerDetailRefreshQueuedShouldRefreshQuota ||= shouldRefreshQuota;
    return;
  }

  providerDetailRefreshInFlight = refresh().then(() => undefined).catch(() => undefined);
  try {
    await providerDetailRefreshInFlight;
    if (shouldRefreshQuota) void refreshProviderQuotaAfterAccountPoll();
  } finally {
    providerDetailRefreshInFlight = null;
    const shouldRefreshAgain = providerDetailRefreshQueued;
    const shouldRefreshQuotaAgain = providerDetailRefreshQueuedShouldRefreshQuota;
    providerDetailRefreshQueued = false;
    providerDetailRefreshQueuedShouldRefreshQuota = false;

    if (shouldRefreshAgain) {
      void refreshProviderDetailOnce({ refreshQuota: shouldRefreshQuotaAgain });
    }
  }
}

function stopProviderDetailRefresh() {
  providerDetailRefreshQueued = false;
  providerDetailRefreshQueuedShouldRefreshQuota = false;
  if (!providerDetailRefreshTimer) return;

  clearInterval(providerDetailRefreshTimer);
  providerDetailRefreshTimer = null;
}

function startProviderDetailRefresh() {
  if (providerDetailRefreshTimer) return;

  providerDetailRefreshTimer = setInterval(() => {
    void refreshProviderDetailOnce();
  }, PROVIDER_DETAIL_REFRESH_MS);
}

async function refreshProviderQuotaAfterAccountPoll() {
  if (!supportsProviderQuota.value || providerQuotaRefreshInFlight) return;

  providerQuotaRefreshInFlight = (async () => {
    await waitForQuotaQueue();
    const accountsToRefresh = quotaCapableAccounts.value.filter((account) => account.isActive || quotaByAccountId.value[account.id]);
    if (accountsToRefresh.length > 0) await runQuotaQueue(accountsToRefresh, true, { append: true });
  })().catch(() => undefined);

  try {
    await providerQuotaRefreshInFlight;
  } finally {
    providerQuotaRefreshInFlight = null;
  }
}

watch(
  detailData,
  (value, previousValue) => {
    if (!value) return;
    if (!previousValue) return;

    const previousAccountIds = new Set(previousValue.accounts.map((account) => account.id));
    const newAccounts = value.accounts.filter((account) => !previousAccountIds.has(account.id));
    if (newAccounts.length === 0) return;
    if (newAccounts.length === value.accounts.length) {
      highlightedAccountIds.value = new Set();
      promotedAccountIds.value = new Set();
      shouldPromoteNextNewAccount = false;
      if (highlightTimer) {
        clearTimeout(highlightTimer);
        highlightTimer = null;
      }
      return;
    }

    highlightedAccountIds.value = new Set(newAccounts.map((account) => account.id));
    if (shouldPromoteNextNewAccount) {
      promotedAccountIds.value = new Set([...promotedAccountIds.value, ...newAccounts.map((account) => account.id)]);
    }
    shouldPromoteNextNewAccount = false;
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      highlightedAccountIds.value = new Set();
      highlightTimer = null;
    }, 5000);
  },
  { immediate: true }
);

watch(selectedProvider, () => {
  highlightedAccountIds.value = new Set();
  promotedAccountIds.value = new Set();
  visibleAccountIds.value = new Set();
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
  shouldPromoteNextNewAccount = false;
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
let queuedVisibleDeferredAccountIds = new Set<string>();
const {
  quotaByAccountId,
  quotaErrorByAccountId,
  quotaLoadingByAccountId,
  cancelQuotaQueue,
  hydrateQuotaCache,
  loadAccountQuota,
  pruneQuotaState,
  runQuotaQueue,
  waitForQuotaQueue,
} = useAccountQuotaMonitor({
  accounts,
  quotaCapableAccounts,
  toQuotaProvider,
  shouldQueueAccount: (account) => account.isActive || visibleAccountIds.value.has(account.id),
});

onBeforeUnmount(() => {
  if (highlightTimer) clearTimeout(highlightTimer);
  stopProviderDetailRefresh();
  accountVisibilityObserver?.disconnect();
  cancelQuotaQueue();
});

onMounted(() => {
  startProviderDetailRefresh();
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

function toTimeMs(value: string | Date | null | undefined): number {
  if (!value) return 0;

  const timeMs = new Date(value).getTime();
  return Number.isNaN(timeMs) ? 0 : timeMs;
}

function compareAccounts(a: Account, b: Account): number {
  const aPromoted = promotedAccountIds.value.has(a.id) ? 1 : 0;
  const bPromoted = promotedAccountIds.value.has(b.id) ? 1 : 0;

  return bPromoted - aPromoted
    || toTimeMs(b.lastUsedAt) - toTimeMs(a.lastUsedAt)
    || toTimeMs(b.createdAt) - toTimeMs(a.createdAt)
    || b.id.localeCompare(a.id);
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
  if (!account) return;

  void loadAccountQuota(account, true).finally(() => {
    void refreshProviderDetailOnce({ refreshQuota: false });
  });
}

function getAccountCardElement(card: { accountId?: string; $el?: Element } | Element): Element | null {
  return card instanceof Element ? card : card.$el ?? null;
}

function refreshAccountVisibilityObserver(resetVisibleAccountIds = false) {
  if (!import.meta.client) return;

  accountVisibilityObserver?.disconnect();

  if (resetVisibleAccountIds || !supportsProviderQuota.value) {
    visibleAccountIds.value = new Set();
  } else {
    const currentAccountIds = new Set(accounts.value.map((account) => account.id));
    const nextVisibleAccountIds = new Set([...visibleAccountIds.value].filter((accountId) => currentAccountIds.has(accountId)));
    if (nextVisibleAccountIds.size !== visibleAccountIds.value.size) visibleAccountIds.value = nextVisibleAccountIds;
  }

  if (!supportsProviderQuota.value) return;

  accountVisibilityObserver = new IntersectionObserver((entries) => {
    const nextVisibleAccountIds = new Set(visibleAccountIds.value);
    let changed = false;

    for (const entry of entries) {
      const accountId = entry.target.getAttribute("data-account-id");
      if (!accountId) continue;

      if (entry.isIntersecting) {
        if (!nextVisibleAccountIds.has(accountId)) {
          nextVisibleAccountIds.add(accountId);
          changed = true;
        }
      } else if (nextVisibleAccountIds.delete(accountId)) {
        changed = true;
      }
    }

    if (changed) visibleAccountIds.value = nextVisibleAccountIds;
  });

  for (const card of accountCardRefs.value) {
    const element = getAccountCardElement(card);
    if (element) accountVisibilityObserver.observe(element);
  }
}

watch(
  accounts,
  async () => {
    await nextTick();
    refreshAccountVisibilityObserver();
  },
  { immediate: true }
);

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
    queuedVisibleDeferredAccountIds = new Set([...queuedVisibleDeferredAccountIds].filter((accountId) => currentQuotaAccountStates.has(accountId) && !quotaByAccountId.value[accountId]));
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

watch(
  () => `${selectedProvider.value}|${accounts.value.map((account) => `${account.id}:${account.provider}:${account.isActive}`).join("|")}|visible:${[...visibleAccountIds.value].sort().join(",")}`,
  () => {
    const accountsToFetch = quotaCapableAccounts.value.filter((account) => {
      if (account.isActive || !visibleAccountIds.value.has(account.id)) return false;
      if (quotaByAccountId.value[account.id] || quotaLoadingByAccountId.value[account.id]) return false;
      return !queuedVisibleDeferredAccountIds.has(account.id);
    });

    if (accountsToFetch.length === 0) return;

    queuedVisibleDeferredAccountIds = new Set([...queuedVisibleDeferredAccountIds, ...accountsToFetch.map((account) => account.id)]);
    void runQuotaQueue(accountsToFetch, false, { append: true });
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

function handleAccountConnected(result: { provider: ProviderAccountKey; isUpdate: boolean }) {
  if (result.provider === selectedProvider.value && !result.isUpdate) shouldPromoteNextNewAccount = true;
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
            v-if="providerMeta"
            :provider-key="providerMeta.key"
            :pinned="pinnedProviders.has(providerMeta.key)"
            :readonly="isAuditMode"
          />
          {{ providerMeta?.label ?? selectedProvider.replaceAll('_', ' ') }}
          <UiBadge v-if="accounts.length > 0" variant="outline" class="text-xs">{{ activeAccountCount }}/{{ accounts.length }}</UiBadge>
        </h2>
        <div class="flex w-full items-center sm:w-auto">
          <AddAccountDialog
            v-if="providerMeta"
            :initial-provider="providerMeta.key"
            :readonly="isAuditMode"
            trigger-class="flex-1 sm:w-auto sm:flex-none"
            @connected="handleAccountConnected"
          />
        </div>
      </div>
    </div>

    <DashboardDataNotice :error="error" />

    <section v-if="!isLoadingAccounts && accounts.length === 0" class="scroll-mt-24 space-y-4 md:space-y-2">
      <div class="space-y-3 pt-1">
        <p class="text-sm text-muted-foreground">{{ providerMeta?.emptyMessage ?? 'No accounts connected yet.' }}</p>
        <div v-if="supportedModels.length" class="space-y-2">
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
      <div v-if="supportsProviderQuota && quotaSummaryGroups.length > 0" class="space-y-2 pb-2 md:mb-4 md:rounded-xl md:border md:border-border md:bg-card md:p-4">
        <div class="grid gap-x-6 gap-y-3 md:grid-cols-2 xl:grid-cols-3">
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
      </div>

      <div class="dashboard-card-grid">
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
