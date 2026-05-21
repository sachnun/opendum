<script setup lang="ts">
import type { ProviderAccountUpdateData, ProviderDetailData, ProviderDetailDeltaData, ProviderDetailResponse, ProviderStats, QuotaGroupDisplay, QuotaProviderKey } from "../../../lib/dashboard-api-types";
import { BY_KEY, getProviderFromSlug, type ProviderAccountKey } from "../../../lib/provider-accounts";
import { warmDashboardIndexedDbStore } from "../../utils/dashboardIndexedDb";

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
const ACCOUNT_STATS_BATCH_SIZE = 24;
const ACCOUNT_STATS_POLL_MS = 30_000;
const QUOTA_AUTO_LOAD_DELAY_MS = 400;
const PROVIDER_DETAIL_REFRESH_MS = 30_000;
const DASHBOARD_CACHE_DB_NAME = "opendum-dashboard";
const ACCOUNT_STATS_STORE_NAME = "account-stats";
const ACCOUNT_QUOTA_STORE_NAME = "account-quota";

const { data, error, pending, refresh } = await useAsyncData(
  () => `dashboard-accounts-detail-${selectedProvider.value}`,
  () => dashboardApi.accounts.byProviderDetailed({ provider: selectedProvider.value }),
  { watch: [selectedProvider] }
);

const detailData = computed<ProviderDetailData | null>(() => data.value ?? null);
const accountDisplayOrder = ref<Record<string, number>>({});
const highlightedAccountIds = ref<Set<string>>(new Set());
const promotedAccountIds = ref<Set<string>>(new Set());
const accountCardRefs = ref<Array<{ accountId?: string; $el?: Element } | Element>>([]);
const accountStatsById = ref<Record<string, ProviderStats>>({});
const accountStatsCursorById = ref<Record<string, string>>({});
const accountStatsDeltaReadyById = ref<Record<string, boolean>>({});
const accountStatsFetchedById = ref<Record<string, boolean>>({});
const hydratedAccountStatsIds = ref<Record<string, boolean>>({});
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
let providerDetailRefreshTimer: ReturnType<typeof setInterval> | null = null;
let accountStatsQueueTimer: ReturnType<typeof setTimeout> | null = null;
let accountStatsPollTimer: ReturnType<typeof setInterval> | null = null;
let providerDetailRefreshInFlight: Promise<void> | null = null;
let providerDetailRefreshQueued = false;
let providerDetailRefreshQueuedShouldRefreshQuota = false;
let providerQuotaRefreshInFlight: Promise<void> | null = null;
let shouldPromoteNextNewAccount = false;
const queuedAccountStatsIds = new Set<string>();
const forceQueuedAccountStatsIds = new Set<string>();
const loadingAccountStatsIds = new Set<string>();
const accounts = computed(() => {
  const currentAccounts = detailData.value?.accounts ?? [];
  return [...currentAccounts].sort(compareDisplayAccounts);
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

  providerDetailRefreshInFlight = refreshProviderDetail().then(() => undefined).catch(() => undefined);
  try {
    await providerDetailRefreshInFlight;
    queueAccountStatsLoad(accounts.value.map((account) => account.id), { force: true });
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
    if (accountsToRefresh.length > 0) await runQuotaQueue(accountsToRefresh, { refreshExisting: true });
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

    const sortedAccounts = [...value.accounts].sort(compareAccounts);
    if (!previousValue || Object.keys(accountDisplayOrder.value).length === 0) {
      accountDisplayOrder.value = Object.fromEntries(sortedAccounts.map((account, index) => [account.id, index]));
      if (!previousValue) return;
    }

    const previousAccountIds = new Set(previousValue.accounts.map((account) => account.id));
    const newAccounts = value.accounts.filter((account) => !previousAccountIds.has(account.id));
    if (newAccounts.length === 0) return;
    if (newAccounts.length === value.accounts.length) {
      accountDisplayOrder.value = Object.fromEntries(sortedAccounts.map((account, index) => [account.id, index]));
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

    const currentOrder = accountDisplayOrder.value;
    const orderedNewAccounts = [...newAccounts].sort(compareAccounts);
    accountDisplayOrder.value = Object.fromEntries([
      ...orderedNewAccounts.map((account, index) => [account.id, index] as const),
      ...Object.entries(currentOrder)
        .filter(([accountId]) => value.accounts.some((account) => account.id === accountId))
        .map(([accountId, order]) => [accountId, order + orderedNewAccounts.length] as const),
    ]);

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
  accountDisplayOrder.value = {};
  highlightedAccountIds.value = new Set();
  promotedAccountIds.value = new Set();
  accountStatsById.value = {};
  accountStatsCursorById.value = {};
  accountStatsDeltaReadyById.value = {};
  accountStatsFetchedById.value = {};
  hydratedAccountStatsIds.value = {};
  queuedAccountStatsIds.clear();
  forceQueuedAccountStatsIds.clear();
  loadingAccountStatsIds.clear();
  if (accountStatsQueueTimer) {
    clearTimeout(accountStatsQueueTimer);
    accountStatsQueueTimer = null;
  }
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
  shouldPromoteNextNewAccount = false;
});

function isProviderDetailDelta(detail: ProviderDetailResponse): detail is ProviderDetailDeltaData {
  return "delta" in detail && detail.delta === true;
}

function applyProviderDetailResponse(detail: ProviderDetailResponse): ProviderDetailData {
  if (!isProviderDetailDelta(detail)) {
    data.value = detail;
    return detail;
  }

  const current = data.value;
  if (!current) throw new Error("Cannot apply provider detail delta without a snapshot");

  const deletedAccountIds = new Set(detail.deletedAccountIds ?? []);
  const changedAccountsById = new Map((detail.accounts ?? []).map((account) => [account.id, account]));
  const clearedDisabledModelIds = new Set(detail.clearedDisabledModelsByAccountId ?? []);
  const clearedModelHealthIds = new Set(detail.clearedModelHealthByAccountId ?? []);
  const nextDisabledModelsByAccountId = {
    ...Object.fromEntries(Object.entries(current.disabledModelsByAccountId).filter(([accountId]) => !clearedDisabledModelIds.has(accountId))),
    ...(detail.disabledModelsByAccountId ?? {}),
  };
  const nextModelHealthByAccountId = {
    ...Object.fromEntries(Object.entries(current.modelHealthByAccountId).filter(([accountId]) => !clearedModelHealthIds.has(accountId))),
    ...(detail.modelHealthByAccountId ?? {}),
  };

  const next: ProviderDetailData = {
    accounts: [
      ...current.accounts
        .filter((account) => !deletedAccountIds.has(account.id))
        .map((account) => changedAccountsById.get(account.id) ?? account),
      ...(detail.accounts ?? []).filter((account) => !current.accounts.some((currentAccount) => currentAccount.id === account.id)),
    ],
    supportedModels: detail.supportedModels ?? current.supportedModels,
    disabledModelsByAccountId: nextDisabledModelsByAccountId,
    modelHealthByAccountId: nextModelHealthByAccountId,
    pinnedProviders: detail.pinnedProviders ?? current.pinnedProviders,
    cursor: detail.cursor,
  };
  data.value = next;
  return next;
}

async function refreshProviderDetail() {
  const cursor = data.value?.cursor;
  applyProviderDetailResponse(cursor
    ? await dashboardApi.accounts.byProviderDetailedDelta({ provider: selectedProvider.value, cursor })
    : await dashboardApi.accounts.byProviderDetailed({ provider: selectedProvider.value }));
}

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
  cancelQuotaQueue,
  hydrateQuotaCache,
  pruneQuotaState,
  runQuotaQueue,
  waitForQuotaQueue,
} = useAccountQuotaMonitor({
  accounts,
  quotaCapableAccounts,
  toQuotaProvider,
});

onBeforeUnmount(() => {
  if (highlightTimer) clearTimeout(highlightTimer);
  if (accountStatsQueueTimer) clearTimeout(accountStatsQueueTimer);
  stopAccountStatsPolling();
  stopProviderDetailRefresh();
  cancelQuotaQueue();
});

onMounted(() => {
  void warmDashboardIndexedDbStore(DASHBOARD_CACHE_DB_NAME, ACCOUNT_STATS_STORE_NAME);
  void warmDashboardIndexedDbStore(DASHBOARD_CACHE_DB_NAME, ACCOUNT_QUOTA_STORE_NAME);
  startProviderDetailRefresh();
  void hydrateAccountStatsCache();
  startAccountStatsPolling();
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
    }));
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
    || Number(b.isActive) - Number(a.isActive)
    || toTimeMs(b.lastUsedAt) - toTimeMs(a.lastUsedAt)
    || toTimeMs(b.createdAt) - toTimeMs(a.createdAt)
    || b.id.localeCompare(a.id);
}

function compareDisplayAccounts(a: Account, b: Account): number {
  const aOrder = accountDisplayOrder.value[a.id];
  const bOrder = accountDisplayOrder.value[b.id];

  if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
  if (aOrder !== undefined) return -1;
  if (bOrder !== undefined) return 1;
  return compareAccounts(a, b);
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

function getAccountWithStats(account: Account): Account {
  const stats = accountStatsById.value[account.id] ?? account.stats;
  return stats === account.stats ? account : { ...account, stats };
}

async function hydrateAccountStatsCache() {
  if (!import.meta.client) return;

  const accountsToHydrate = accounts.value.filter((account) => !hydratedAccountStatsIds.value[account.id]);
  if (accountsToHydrate.length === 0) return;

  const cachedStats = await readCachedAccountStats(accountsToHydrate.map((account) => account.id));
  const nextStatsById = { ...accountStatsById.value };
  const nextHydratedIds = { ...hydratedAccountStatsIds.value };
  let hasStatsChanges = false;

  for (const [index, cached] of cachedStats.entries()) {
    const account = accountsToHydrate[index];
    if (!account) continue;

    nextHydratedIds[account.id] = true;
    if (!cached || cached.accountId !== account.id) continue;
    if (accountStatsById.value[account.id]) continue;

    nextStatsById[account.id] = cached.stats;
    hasStatsChanges = true;
  }

  for (const account of accountsToHydrate) nextHydratedIds[account.id] = true;
  hydratedAccountStatsIds.value = nextHydratedIds;
  if (hasStatsChanges) {
    accountStatsById.value = nextStatsById;
  }
}

function queueAccountStatsLoad(accountIds: Iterable<string>, options: { force?: boolean } = {}) {
  if (!import.meta.client) return;

  for (const accountId of accountIds) {
    if (!options.force && accountStatsFetchedById.value[accountId]) continue;
    if (loadingAccountStatsIds.has(accountId)) continue;
    queuedAccountStatsIds.add(accountId);
    if (options.force) forceQueuedAccountStatsIds.add(accountId);
  }

  if (queuedAccountStatsIds.size === 0 || accountStatsQueueTimer) return;
  accountStatsQueueTimer = setTimeout(() => {
    accountStatsQueueTimer = null;
    void flushQueuedAccountStats();
  }, 80);
}

async function flushQueuedAccountStats() {
  const accountIds = Array.from(queuedAccountStatsIds).slice(0, ACCOUNT_STATS_BATCH_SIZE);
  for (const accountId of accountIds) queuedAccountStatsIds.delete(accountId);
  const force = accountIds.some((accountId) => forceQueuedAccountStatsIds.has(accountId));
  for (const accountId of accountIds) forceQueuedAccountStatsIds.delete(accountId);

  await loadAccountStats(accountIds, { force });

  if (queuedAccountStatsIds.size > 0) {
    accountStatsQueueTimer = setTimeout(() => {
      accountStatsQueueTimer = null;
      void flushQueuedAccountStats();
    }, 80);
  }
}

function startAccountStatsPolling() {
  if (!import.meta.client || accountStatsPollTimer) return;

  accountStatsPollTimer = setInterval(() => {
    if (document.hidden) return;
    queueAccountStatsLoad(accounts.value.map((account) => account.id), { force: true });
  }, ACCOUNT_STATS_POLL_MS);
}

function stopAccountStatsPolling() {
  if (!accountStatsPollTimer) return;

  clearInterval(accountStatsPollTimer);
  accountStatsPollTimer = null;
}

async function loadAccountStats(accountIds: string[], options: { force?: boolean } = {}) {
  const availableAccountIds = new Set(accounts.value.map((account) => account.id));
  const requestedAccountIds = Array.from(new Set(accountIds))
    .filter((accountId) => availableAccountIds.has(accountId))
    .filter((accountId) => !loadingAccountStatsIds.has(accountId))
    .filter((accountId) => options.force || !accountStatsFetchedById.value[accountId]);

  if (requestedAccountIds.length === 0) return;

  for (const accountId of requestedAccountIds) loadingAccountStatsIds.add(accountId);

  try {
    const response = await dashboardApi.accounts.stats({
      accountIds: requestedAccountIds,
      cursors: Object.fromEntries(requestedAccountIds.map((accountId) => [accountId, accountStatsCursorById.value[accountId] ?? ""])),
    });
    const stats = response.stats ?? {};
    const nextDeltaReadyById = { ...accountStatsDeltaReadyById.value };
    const nextFetchedById = { ...accountStatsFetchedById.value };
    const nextCursorById = { ...accountStatsCursorById.value, ...response.cursors };

    for (const accountId of requestedAccountIds) {
      nextDeltaReadyById[accountId] = Boolean(accountStatsById.value[accountId] || accountStatsDeltaReadyById.value[accountId]);
      nextFetchedById[accountId] = true;
    }

    accountStatsById.value = { ...accountStatsById.value, ...stats };
    accountStatsCursorById.value = nextCursorById;
    accountStatsDeltaReadyById.value = nextDeltaReadyById;
    accountStatsFetchedById.value = nextFetchedById;
    void writeCachedAccountStats(stats);
  } catch (error) {
    console.error("Failed to load account stats:", error);
  } finally {
    for (const accountId of requestedAccountIds) loadingAccountStatsIds.delete(accountId);
  }
}

function pruneAccountStats() {
  const availableAccountIds = new Set(accounts.value.map((account) => account.id));
  accountStatsById.value = Object.fromEntries(Object.entries(accountStatsById.value).filter(([accountId]) => availableAccountIds.has(accountId)));
  accountStatsCursorById.value = Object.fromEntries(Object.entries(accountStatsCursorById.value).filter(([accountId]) => availableAccountIds.has(accountId)));
  accountStatsDeltaReadyById.value = Object.fromEntries(Object.entries(accountStatsDeltaReadyById.value).filter(([accountId]) => availableAccountIds.has(accountId)));
  accountStatsFetchedById.value = Object.fromEntries(Object.entries(accountStatsFetchedById.value).filter(([accountId]) => availableAccountIds.has(accountId)));
  hydratedAccountStatsIds.value = Object.fromEntries(Object.entries(hydratedAccountStatsIds.value).filter(([accountId]) => availableAccountIds.has(accountId)));
  for (const accountId of forceQueuedAccountStatsIds) {
    if (!availableAccountIds.has(accountId)) forceQueuedAccountStatsIds.delete(accountId);
  }
}

watch(
  accounts,
  () => {
    pruneAccountStats();
    void hydrateAccountStatsCache();
    queueAccountStatsLoad(accounts.value.map((account) => account.id));
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
    void hydrateQuotaCache();
    previousQuotaAccountKeys = currentQuotaAccountKeys;
    previousQuotaAccountStates = currentQuotaAccountStates;
    previousQuotaProvider = selectedProvider.value;

    if (accountsToFetch.length === 0) return;

    let cancelled = false;
    const quotaLoadTimer = setTimeout(() => {
      if (!cancelled) void runQuotaQueue(accountsToFetch, { refreshExisting: shouldRefreshExisting });
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
        <div class="grid gap-x-6 gap-y-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 min-[1920px]:grid-cols-5">
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
          :account="getAccountWithStats(account)"
          :data-account-id="account.id"
          :show-tier="providerMeta?.showTier"
          :supported-models="supportedModels"
          :disabled-models="disabledModelsByAccountId[account.id] ?? []"
          :model-health="modelHealthByAccountId[account.id] ?? {}"
          :quota-info="quotaByAccountId[account.id] ?? null"
          :quota-error="quotaErrorByAccountId[account.id] ?? null"
          :highlight="highlightedAccountIds.has(account.id)"
          :animate-deltas="accountStatsDeltaReadyById[account.id] === true"
          :readonly="isAuditMode"
          @renamed="handleAccountRenamed"
          @active-updated="handleAccountActiveUpdated"
          @temporarily-disabled="handleAccountActiveUpdated"
          @deleted="handleAccountDeleted"
          @errors-resolved="handleAccountErrorsResolved"
        />
      </div>
    </section>
  </div>
</template>
