<script setup lang="ts">
import type { ActionResult, CustomListItem, CustomModelRow, ErrorHistoryResult, AccountUpdateData, ProviderDetailData, ProviderStats, QuotaGroupDisplay, QuotaProviderKey } from "~~/lib/api-types";
import { decodeHash, settle } from "~~/lib/settle";
import type { AccountsData, UsageData } from "@opendum/providers/contract";
import { BY_KEY, providerOf, QUOTA_PROVIDER_KEYS, type ProviderAccountKey } from "@opendum/providers/provider-accounts";
import { COMMON_HEADER_NAMES } from "~~/lib/headers";
import { messageOf } from "~~/lib/utils";

definePageMeta({
  middleware: ["provider", "auth"],
  layout: "web",
});

interface ProviderMeta {
  key: string;
  slug: string;
  label: string;
  showTier: boolean;
}

interface HeaderRow {
  key: string;
  value: string;
}

interface ModelRow {
  model: string;
  alias: string;
  aliased: boolean;
}

interface SettingsForm {
  name: string;
  baseUrl: string;
  headers: HeaderRow[];
  models: ModelRow[];
  enabled: boolean;
}

const route = useRoute();
const api = useApi();
const { isAuditMode } = useAudit();
const invalidation = useInvalidate();
const routeProvider = computed(() => String("provider" in route.params ? route.params.provider : ""));
const selectedProvider = computed<string>(() => providerOf(routeProvider.value) ?? routeProvider.value);
const { data: customProvidersData, refresh: refreshCustomProviders } = useAsyncData(dataKeys.customProviders, () => api.customProviders.list());
const customProvider = computed<CustomListItem | null>(() => (customProvidersData.value ?? []).find((row) => row.slug === selectedProvider.value) ?? null);
const providerMeta = computed<ProviderMeta | null>(() => {
  const builtin = BY_KEY[selectedProvider.value as ProviderAccountKey];
  if (builtin) return { key: builtin.key, slug: builtin.slug, label: builtin.label, showTier: builtin.showTier };
  const custom = customProvider.value;
  if (custom) return { key: custom.slug, slug: custom.slug, label: custom.name, showTier: false };
  return null;
});
const providerSlug = computed(() => providerMeta.value?.slug ?? selectedProvider.value);
const providerNotFound = computed(() => !providerMeta.value && customProvidersData.value !== undefined);

watch(providerNotFound, (value) => {
  if (value) void navigateTo("/", { replace: true });
}, { immediate: true });

type Account = ProviderDetailData["accounts"][number];
type ErrorHistoryEntry = Extract<ErrorHistoryResult, { success: true }>["data"]["entries"][number];
type QuotaSummaryGroup = Pick<QuotaGroupDisplay, "name" | "displayName"> & {
  remainingRequests: number;
  maxRequests: number;
  usedRequests: number;
  remainingFraction: number;
  percentUsed: number;
  accounts: number;
};

const QUOTA_PROVIDERS = new Set<string>(QUOTA_PROVIDER_KEYS);
const STATS_BATCH_SIZE = 24;
const HISTORY_BATCH_SIZE = 20;
const STATS_ROOT_MARGIN = "600px 0px";
const QUOTA_DELAY_MS = 400;
const HIGHLIGHT_DURATION_MS = 2500;

const { data, error, pending, refresh } = useAsyncData(
  () => dataKeys.accountsDetail(selectedProvider.value),
  () => api.accounts.byProviderDetailed({ provider: selectedProvider.value }),
  { watch: [selectedProvider] }
);

const detailData = computed<ProviderDetailData | null>(() => data.value ?? null);
const accountDisplayOrder = ref<Record<string, number>>({});
const highlightedAccountIds = ref<Set<string>>(new Set());
const promotedAccountIds = ref<Set<string>>(new Set());
const accountCardRefs = ref<Array<{ accountId?: string; $el?: Element } | Element>>([]);
const providerRoot = ref<HTMLElement | null>(null);
const visibleAccountIds = reactive(new Set<string>());
const intersectingAccountIds = new Set<string>();
const statsById = shallowReactive<Record<string, ProviderStats>>({});
const deltaReady = ref<Record<string, boolean>>({});
const statsFetched = ref<Record<string, boolean>>({});
const historyById = ref<Record<string, ErrorHistoryEntry[] | null>>({});
const historyError = ref<Record<string, string | null>>({});
const historyFetched = ref<Record<string, boolean>>({});
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
let statsTimer: ReturnType<typeof setTimeout> | null = null;
let historyTimer: ReturnType<typeof setTimeout> | null = null;
let accountsObserver: IntersectionObserver | null = null;
let quotaRefreshing: Promise<void> | null = null;
let shouldPromoteNew = false;
const queuedStatsIds = new Set<string>();
const forceStatsIds = new Set<string>();
const loadingStatsIds = new Set<string>();
const queuedHistoryIds = new Set<string>();
const loadingHistoryIds = new Set<string>();
const accounts = computed(() => {
  const currentAccounts = detailData.value?.accounts ?? [];
  return [...currentAccounts].sort(compareAccounts);
});
const activeAccountCount = computed(() => accounts.value.filter((account) => account.isActive).length);
const isLoadingAccounts = computed(() => pending.value || (!detailData.value && !error.value));
const pinnedProviders = computed(() => new Set(detailData.value?.pinnedProviders ?? []));
const supportedModels = computed(() => detailData.value?.supportedModels ?? []);
const supportedByAccount = computed(() => detailData.value?.supportedByAccount ?? {});
const freeSupportedModels = computed(() => detailData.value?.freeSupportedModels ?? []);
const freeModels = computed<Set<string> | null>(() => (detailData.value ? new Set(freeSupportedModels.value) : null));
const orderedSupportedModels = computed(() => {
  const freeIds = freeModels.value;
  if (!freeIds) return supportedModels.value;

  const free: string[] = [];
  const restricted: string[] = [];
  for (const model of supportedModels.value) {
    (freeIds.has(model) ? free : restricted).push(model);
  }
  return [...free, ...restricted];
});
const disabledModels = computed(() => detailData.value?.disabledModelsByAccountId ?? {});
const healthByAccount = computed(() => detailData.value?.modelHealthByAccountId ?? {});
const supportsProviderQuota = computed(() => QUOTA_PROVIDERS.has(selectedProvider.value));
const selectedAccountId = computed(() => hashAccount(route.hash));
type QuotaAccountState = { provider: string; isActive: boolean };

async function refreshQuota() {
  if (!supportsProviderQuota.value || quotaRefreshing) return;

  quotaRefreshing = (async () => {
    await waitForQueue();
    const accountsToRefresh = quotaCapableAccounts.value.filter((account) => account.isActive || quotaById.value[account.id]);
    if (accountsToRefresh.length > 0) await runQuotaQueue(accountsToRefresh, { refreshExisting: true });
  })().catch(() => undefined);

  await settle(() => quotaRefreshing as Promise<void>);
  quotaRefreshing = null;
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
      shouldPromoteNew = false;
      if (highlightTimer) {
        clearTimeout(highlightTimer);
        highlightTimer = null;
      }
      return;
    }

    highlightedAccountIds.value = new Set(newAccounts.map((account) => account.id));
    if (shouldPromoteNew) {
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

    shouldPromoteNew = false;
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      highlightedAccountIds.value = new Set();
      highlightTimer = null;
    }, HIGHLIGHT_DURATION_MS);
  },
  { immediate: true }
);

watch(selectedProvider, () => {
  accountDisplayOrder.value = {};
  highlightedAccountIds.value = new Set();
  promotedAccountIds.value = new Set();
  for (const accountId of Object.keys(statsById)) Reflect.deleteProperty(statsById, accountId);
  visibleAccountIds.clear();
  intersectingAccountIds.clear();
  deltaReady.value = {};
  statsFetched.value = {};
  historyById.value = {};
  historyError.value = {};
  historyFetched.value = {};
  prevErrorAt.value = {};
  queuedStatsIds.clear();
  forceStatsIds.clear();
  loadingStatsIds.clear();
  queuedHistoryIds.clear();
  loadingHistoryIds.clear();
  if (statsTimer) {
    clearTimeout(statsTimer);
    statsTimer = null;
  }
  if (historyTimer) {
    clearTimeout(historyTimer);
    historyTimer = null;
  }
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
  shouldPromoteNew = false;
});

function applyAccounts(snapshot: AccountsData): void {
  const detail = snapshot.providers[selectedProvider.value];
  if (!detail) return;

  data.value = detail;
  queueStats(Array.from(intersectingAccountIds), { force: true });
  void refreshQuota();
}

function applyUsage(snapshot: UsageData): void {
  for (const [accountId, stats] of Object.entries(snapshot.accountStats)) statsById[accountId] = stats;
}

useLiveEvent("usage", applyUsage);
useLiveEvent("accounts", applyAccounts);

watch(
  [accounts, selectedAccountId],
  async ([currentAccounts, accountId]) => {
    if (!accountId || !currentAccounts.some((account) => account.id === accountId)) return;

    highlightedAccountIds.value = new Set([accountId]);
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      highlightedAccountIds.value = new Set();
      highlightTimer = null;
    }, HIGHLIGHT_DURATION_MS);

    await nextTick();
    const accountCard = accountCardRefs.value.find((card) => {
      if (card instanceof Element) return card.getAttribute("data-account-id") === accountId;
      return card.accountId === accountId || card.$el?.getAttribute("data-account-id") === accountId;
    });
    const accountElement = accountCard instanceof Element ? accountCard : accountCard?.$el;
    accountElement?.scrollIntoView({ block: "center", behavior: "smooth" });

    setTimeout(() => {
      if (route.path === `/${providerSlug.value}` && hashAccount(route.hash) === accountId) {
        if (typeof window !== "undefined") {
          window.history.replaceState(window.history.state, "", route.path);
        }
      }
    }, 60);
  },
  { immediate: true }
);

const quotaCapableAccounts = computed(() => accounts.value.filter((account) => account.provider === selectedProvider.value && quotaOf(account.provider)));
const activeQuotaAccounts = computed(() => quotaCapableAccounts.value.filter((account) => account.isActive));
let prevQuotaKeys = new Set<string>();
let prevQuotaStates = new Map<string, QuotaAccountState>();
let previousQuotaProvider: string | null = null;
const {
  quotaById,
  errorById,
  cancelQuotaQueue,
  pruneQuotaState,
  runQuotaQueue,
  waitForQueue,
} = useQuotaMonitor({
  accounts,
  quotaCapableAccounts,
  toQuotaProvider: quotaOf,
});

onBeforeUnmount(() => {
  if (highlightTimer) clearTimeout(highlightTimer);
  if (statsTimer) clearTimeout(statsTimer);
  if (historyTimer) clearTimeout(historyTimer);
  accountsObserver?.disconnect();
  accountsObserver = null;
  cancelQuotaQueue();
});

onMounted(() => {
  accountsObserver = new IntersectionObserver((entries) => {
    const visibleIds: string[] = [];

    for (const entry of entries) {
      const accountId = (entry.target as HTMLElement).dataset.accountId;
      if (!accountId) continue;

      if (!entry.isIntersecting) {
        intersectingAccountIds.delete(accountId);
        continue;
      }

      visibleAccountIds.add(accountId);
      intersectingAccountIds.add(accountId);
      visibleIds.push(accountId);
    }

    if (visibleIds.length > 0) {
      queueStats(visibleIds);
      queueHistory(visibleIds);
    }
  }, { rootMargin: STATS_ROOT_MARGIN });
  observeCards();
});
const quotaSummaryGroups = computed<QuotaSummaryGroup[]>(() => {
  const groups = new Map<string, QuotaSummaryGroup>();

  for (const account of activeQuotaAccounts.value) {
    const quota = quotaById.value[account.id];
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
function quotaOf(provider: string): QuotaProviderKey | null {
  return QUOTA_PROVIDERS.has(provider) ? provider as QuotaProviderKey : null;
}

function timeOf(value: string | Date | null | undefined): number {
  if (!value) return 0;

  const timeMs = new Date(value).getTime();
  return Number.isNaN(timeMs) ? 0 : timeMs;
}

function compareAccounts(a: Account, b: Account): number {
  const aPromoted = promotedAccountIds.value.has(a.id) ? 1 : 0;
  const bPromoted = promotedAccountIds.value.has(b.id) ? 1 : 0;

  return bPromoted - aPromoted
    || Number(b.isActive) - Number(a.isActive)
    || timeOf(b.lastUsedAt) - timeOf(a.lastUsedAt)
    || timeOf(b.createdAt) - timeOf(a.createdAt)
    || b.id.localeCompare(a.id);
}

function byOrder(a: Account, b: Account): number {
  const aOrder = accountDisplayOrder.value[a.id];
  const bOrder = accountDisplayOrder.value[b.id];

  if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
  if (aOrder !== undefined) return -1;
  if (bOrder !== undefined) return 1;
  return compareAccounts(a, b);
}

function percentLeft(group: QuotaSummaryGroup): number {
  return Math.max(0, Math.min(100, Math.round(group.remainingFraction * 100)));
}

function barColor(group: QuotaSummaryGroup): string {
  const percentRemaining = percentLeft(group);
  if (percentRemaining <= 10) return "bg-red-500";
  if (percentRemaining <= 25) return "bg-orange-500";
  if (percentRemaining <= 50) return "bg-yellow-500";
  return "bg-green-500";
}

function withStats(account: Account): Account {
  const stats = statsById[account.id] ?? account.stats;
  return stats === account.stats ? account : { ...account, stats };
}

function queueStats(accountIds: Iterable<string>, options: { force?: boolean } = {}) {
  if (!import.meta.client) return;

  for (const accountId of accountIds) {
    if (!options.force && statsFetched.value[accountId]) continue;
    if (loadingStatsIds.has(accountId)) continue;
    queuedStatsIds.add(accountId);
    if (options.force) forceStatsIds.add(accountId);
  }

  if (queuedStatsIds.size === 0 || statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    void flushStats();
  }, 80);
}

function queueHistory(accountIds: Iterable<string>, options: { force?: boolean } = {}) {
  if (!import.meta.client) return;

  for (const accountId of accountIds) {
    if (!options.force && historyFetched.value[accountId]) continue;
    if (loadingHistoryIds.has(accountId)) continue;
    queuedHistoryIds.add(accountId);
  }

  if (queuedHistoryIds.size === 0 || historyTimer) return;
  historyTimer = setTimeout(() => {
    historyTimer = null;
    void flushHistory();
  }, 80);
}

async function flushHistory() {
  const accountIds = Array.from(queuedHistoryIds).slice(0, HISTORY_BATCH_SIZE);
  for (const accountId of accountIds) queuedHistoryIds.delete(accountId);

  await loadHistories(accountIds);

  if (queuedHistoryIds.size > 0) {
    historyTimer = setTimeout(() => {
      historyTimer = null;
      void flushHistory();
    }, 80);
  }
}

async function flushStats() {
  const accountIds = Array.from(queuedStatsIds).slice(0, STATS_BATCH_SIZE);
  for (const accountId of accountIds) queuedStatsIds.delete(accountId);
  const force = accountIds.some((accountId) => forceStatsIds.has(accountId));
  for (const accountId of accountIds) forceStatsIds.delete(accountId);

  await loadStats(accountIds, { force });

  if (queuedStatsIds.size > 0) {
    statsTimer = setTimeout(() => {
      statsTimer = null;
      void flushStats();
    }, 80);
  }
}

function observeCards() {
  if (!import.meta.client || !accountsObserver) return;
  const root = providerRoot.value;
  if (!root) return;

  accountsObserver.disconnect();
  intersectingAccountIds.clear();

  for (const element of root.querySelectorAll<HTMLElement>("[data-account-id]")) {
    accountsObserver.observe(element);
  }
}

async function loadStats(accountIds: string[], options: { force?: boolean } = {}) {
  const availableAccountIds = new Set(accounts.value.map((account) => account.id));
  const requestedAccountIds = Array.from(new Set(accountIds))
    .filter((accountId) => availableAccountIds.has(accountId))
    .filter((accountId) => !loadingStatsIds.has(accountId))
    .filter((accountId) => options.force || !statsFetched.value[accountId]);

  if (requestedAccountIds.length === 0) return;

  for (const accountId of requestedAccountIds) loadingStatsIds.add(accountId);

  const loaded = await settle(() => api.accounts.stats({ accountIds: requestedAccountIds }));
  if (loaded.ok) {
    const stats = loaded.value;
    const nextDelta = { ...deltaReady.value };
    const nextFetched = { ...statsFetched.value };

    for (const accountId of requestedAccountIds) {
      nextDelta[accountId] = Boolean(statsById[accountId] || deltaReady.value[accountId]);
      nextFetched[accountId] = true;
    }

    for (const [accountId, stat] of Object.entries(stats)) statsById[accountId] = stat;
    deltaReady.value = nextDelta;
    statsFetched.value = nextFetched;
  } else {
    console.error("Failed to load account stats:", loaded.error);
  }
  for (const accountId of requestedAccountIds) loadingStatsIds.delete(accountId);
}

async function loadHistories(accountIds: string[]) {
  const availableAccountIds = new Set(accounts.value.map((account) => account.id));
  const requestedAccountIds = Array.from(new Set(accountIds))
    .filter((accountId) => availableAccountIds.has(accountId))
    .filter((accountId) => !loadingHistoryIds.has(accountId));

  if (requestedAccountIds.length === 0) return;

  for (const accountId of requestedAccountIds) loadingHistoryIds.add(accountId);

  const loaded = await settle(() => api.accounts.errorHistories({ accountIds: requestedAccountIds, limit: 100 }));
  if (loaded.ok && loaded.value.success) {
    const response = loaded.value;
    const nextHistory = { ...historyById.value };
    const nextError = { ...historyError.value };
    const nextFetched = { ...historyFetched.value };

    for (const accountId of requestedAccountIds) {
      const result = response.data[accountId];
      nextFetched[accountId] = true;
      if (!result?.success) {
        nextHistory[accountId] = [];
        nextError[accountId] = null;
        continue;
      }

      nextHistory[accountId] = result.data.entries;
      nextError[accountId] = null;
    }

    historyById.value = nextHistory;
    historyError.value = nextError;
    historyFetched.value = nextFetched;
  } else {
    console.error("Failed to load account error histories:", loaded.ok ? "request failed" : loaded.error);
    historyById.value = { ...historyById.value, ...Object.fromEntries(requestedAccountIds.map((accountId) => [accountId, []])) };
    historyError.value = { ...historyError.value, ...Object.fromEntries(requestedAccountIds.map((accountId) => [accountId, null])) };
    historyFetched.value = { ...historyFetched.value, ...Object.fromEntries(requestedAccountIds.map((accountId) => [accountId, true])) };
  }
  for (const accountId of requestedAccountIds) loadingHistoryIds.delete(accountId);
}

function pruneStats() {
  const availableAccountIds = new Set(accounts.value.map((account) => account.id));
  for (const accountId of Object.keys(statsById)) {
    if (!availableAccountIds.has(accountId)) Reflect.deleteProperty(statsById, accountId);
  }
  deltaReady.value = Object.fromEntries(Object.entries(deltaReady.value).filter(([accountId]) => availableAccountIds.has(accountId)));
  statsFetched.value = Object.fromEntries(Object.entries(statsFetched.value).filter(([accountId]) => availableAccountIds.has(accountId)));
  for (const accountId of forceStatsIds) {
    if (!availableAccountIds.has(accountId)) forceStatsIds.delete(accountId);
  }
  for (const accountId of visibleAccountIds) {
    if (!availableAccountIds.has(accountId)) visibleAccountIds.delete(accountId);
  }
  for (const accountId of intersectingAccountIds) {
    if (!availableAccountIds.has(accountId)) intersectingAccountIds.delete(accountId);
  }
}

function pruneHistories() {
  const availableAccountIds = new Set(accounts.value.map((account) => account.id));
  historyById.value = Object.fromEntries(Object.entries(historyById.value).filter(([accountId]) => availableAccountIds.has(accountId)));
  historyError.value = Object.fromEntries(Object.entries(historyError.value).filter(([accountId]) => availableAccountIds.has(accountId)));
  historyFetched.value = Object.fromEntries(Object.entries(historyFetched.value).filter(([accountId]) => availableAccountIds.has(accountId)));
}

watch(
  accounts,
  () => {
    pruneStats();
    pruneHistories();
  },
  { immediate: true }
);

watch(
  () => accounts.value.map((account) => account.id).sort().join("|"),
  async () => {
    await nextTick();
    observeCards();
  },
  { immediate: true }
);

const prevErrorAt = ref<Record<string, number>>({});

watch(
  () => accounts.value.map((account) => `${account.id}:${timeOf(account.lastErrorAt)}`).join("|"),
  () => {
    const previousById = prevErrorAt.value;
    const changedAccountIds: string[] = [];
    const nextById: Record<string, number> = {};

    for (const account of accounts.value) {
      const lastErrorMs = timeOf(account.lastErrorAt);
      nextById[account.id] = lastErrorMs;

      const previousMs = previousById[account.id];
      if (previousMs === undefined || lastErrorMs > previousMs) {
        changedAccountIds.push(account.id);
      }
    }

    prevErrorAt.value = nextById;

    if (changedAccountIds.length > 0) {
      queueHistory(changedAccountIds, { force: true });
    }
  }
);

watch(
  () => `${selectedProvider.value}|${accounts.value.map((account) => `${account.id}:${account.provider}:${account.isActive}`).join("|")}`,
  (_, __, onCleanup) => {
    const providerChanged = previousQuotaProvider !== selectedProvider.value;
    const quotaKeys = new Set(quotaCapableAccounts.value.map((account) => `${account.id}:${account.provider}`));
    const quotaStates = new Map(quotaCapableAccounts.value.map((account) => [account.id, { provider: account.provider, isActive: account.isActive }]));
    const newQuotaAccounts = quotaCapableAccounts.value.filter((account) => !prevQuotaKeys.has(`${account.id}:${account.provider}`));
    const reenabledWithoutQuota = quotaCapableAccounts.value.filter((account) => {
      const previousState = prevQuotaStates.get(account.id);
      return previousState?.provider === account.provider && previousState.isActive === false && account.isActive && !quotaById.value[account.id];
    });
    const shouldRefreshExisting = prevQuotaKeys.size === 0 || providerChanged;
    const accountsToFetch = shouldRefreshExisting
      ? quotaCapableAccounts.value
      : newQuotaAccounts.length > 0
        ? newQuotaAccounts
        : reenabledWithoutQuota;

    pruneQuotaState();
    cancelQuotaQueue();
    prevQuotaKeys = quotaKeys;
    prevQuotaStates = quotaStates;
    previousQuotaProvider = selectedProvider.value;

    if (accountsToFetch.length === 0) return;

    let cancelled = false;
    const quotaLoadTimer = setTimeout(() => {
      if (!cancelled) void runQuotaQueue(accountsToFetch, { refreshExisting: shouldRefreshExisting });
    }, QUOTA_DELAY_MS);

    onCleanup(() => {
      cancelled = true;
      clearTimeout(quotaLoadTimer);
      cancelQuotaQueue();
    });
  },
  { immediate: true }
);

function onRenamed(account: AccountUpdateData) {
  invalidation.patchProviderAccount(selectedProvider.value, account.id, { name: account.name });
  invalidation.patchName(account.id, account.name);
}

function onActive(account: AccountUpdateData) {
  invalidation.patchProviderAccount(selectedProvider.value, account.id, account);
  void invalidation.invalidateAccountOverview();
  invalidation.clearOptions();
  invalidation.clearModelAvailability();
}

function onDeleted(accountId: string) {
  invalidation.removeProviderAccount(selectedProvider.value, accountId);
  void invalidation.invalidateAccountOverview();
  invalidation.clearOptions();
  invalidation.clearModelAvailability();
}

function onResolved(accountId: string) {
  historyById.value = { ...historyById.value, [accountId]: [] };
  historyError.value = { ...historyError.value, [accountId]: null };
  historyFetched.value = { ...historyFetched.value, [accountId]: true };
  void refresh();
  void invalidation.invalidateAccountOverview();
}

function onConnected(result: { provider: string; isUpdate: boolean }) {
  if (result.provider === selectedProvider.value && !result.isUpdate) shouldPromoteNew = true;
}

const settingsOpen = ref(false);
const settingsForm = ref<SettingsForm | null>(null);
const settingsBusy = ref("");
const settingsError = ref("");
const customModels = computed<CustomModelRow[]>(() => customProvider.value?.models ?? []);
const filledSettingsModels = computed(() => (settingsForm.value?.models ?? []).filter((row) => row.model.trim() !== ""));

function customRow(model: CustomModelRow): ModelRow {
  const upstream = model.upstream ?? "";
  const source = upstream || model.modelId;
  return { model: source, alias: model.modelId === source ? "" : model.modelId, aliased: model.aliased || model.modelId !== source };
}

function setAlias(row: ModelRow, value: string) {
  row.alias = value;
  row.aliased = value !== "";
}

function openSettings() {
  const custom = customProvider.value;
  if (!custom) return;
  settingsForm.value = {
    name: custom.name,
    baseUrl: custom.baseUrl,
    headers: Object.entries(custom.extraHeaders ?? {}).map(([key, value]) => ({ key, value })),
    models: custom.models.map(customRow),
    enabled: custom.enabled,
  };
  settingsError.value = "";
  settingsOpen.value = true;
}

watch(() => settingsForm.value?.headers, (rows) => {
  if (!rows) return;
  for (let index = rows.length - 2; index >= 0; index--) {
    const row = rows[index];
    if (row && row.key.trim() === "") rows.splice(index, 1);
  }
  const last = rows[rows.length - 1];
  if (!last || last.key.trim() !== "") rows.push({ key: "", value: "" });
}, { deep: true });

watch(() => settingsForm.value?.models, (rows) => {
  if (!rows) return;
  for (let index = rows.length - 2; index >= 0; index--) {
    const row = rows[index];
    if (row && row.model.trim() === "") rows.splice(index, 1);
  }
  const last = rows[rows.length - 1];
  if (!last || last.model.trim() !== "") rows.push({ model: "", alias: "", aliased: false });
}, { deep: true });

function headersPayload(form: SettingsForm): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const row of form.headers) {
    const key = row.key.trim();
    const value = row.value.trim();
    if (key && value) headers[key] = value;
  }
  return headers;
}

function runAction(action: () => Promise<ActionResult<unknown>>, key: string) {
  settingsBusy.value = key;
  settingsError.value = "";
  return action()
    .then(async (result) => {
      if (!result.success) {
        settingsError.value = result.error;
        return false;
      }
      await refreshCustomProviders();
      return true;
    })
    .catch((error) => {
      settingsError.value = messageOf(error);
      return false;
    })
    .finally(() => {
      settingsBusy.value = "";
    });
}

async function saveSettings() {
  const form = settingsForm.value;
  const key = providerMeta.value?.key;
  if (!form || !key) return;
  settingsBusy.value = "save";
  settingsError.value = "";
  const saved = await settle(() =>
    api.customProviders.update({
      slug: key,
      name: form.name.trim() || undefined,
      baseUrl: form.baseUrl.trim() || undefined,
      extraHeaders: headersPayload(form),
      enabled: form.enabled,
    })
  );
  settingsBusy.value = "";
  if (!saved.ok) {
    settingsError.value = messageOf(saved.error);
    return;
  }
  if (!saved.value.success) {
    settingsError.value = saved.value.error;
    return;
  }
  {
    const desired = form.models
      .filter((row) => row.model.trim() !== "")
      .map((row) => ({ modelId: row.alias.trim() || row.model.trim(), upstream: row.model.trim(), aliased: row.aliased }));
    const desiredIds = new Set(desired.map((row) => row.modelId));
    for (const model of customModels.value.filter((row) => !desiredIds.has(row.modelId))) {
      const removed = await api.customProviders.deleteModel({ slug: key, modelId: model.modelId });
      if (!removed.success) {
        settingsError.value = removed.error;
        return;
      }
    }
    if (desired.length > 0) {
      const added = await api.customProviders.addModels({ slug: key, models: desired });
      if (!added.success) {
        settingsError.value = added.error;
        return;
      }
    }

    await refreshCustomProviders();
    settingsOpen.value = false;
  }
}

async function syncModels() {
  const key = providerMeta.value?.key;
  if (!key || !settingsForm.value) return;
  const ok = await runAction(() => api.customProviders.syncModels({ slug: key }), "model-sync");
  if (ok && settingsForm.value) settingsForm.value.models = customModels.value.map(customRow);
}

const deleteOpen = ref(false);
const deleteBusy = ref(false);
const deleteError = ref("");

async function deleteProvider() {
  const key = providerMeta.value?.key;
  if (!key) return;
  deleteBusy.value = true;
  deleteError.value = "";
  const removed = await settle(() => api.customProviders.remove({ slug: key }));
  deleteBusy.value = false;
  if (!removed.ok) {
    deleteError.value = messageOf(removed.error);
    return;
  }
  if (!removed.value.success) {
    deleteError.value = removed.value.error;
    return;
  }
  deleteOpen.value = false;
  settingsOpen.value = false;
  await refreshCustomProviders();
  await navigateTo("/");
}

function hashAccount(hash: string): string | null {
  const accountId = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!accountId) return null;

  return decodeHash(accountId);
}
</script>

<template>
  <div ref="providerRoot" class="space-y-6">
    <div class="web-header-divider">
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
        <div class="flex w-full items-center justify-end gap-2 sm:w-auto">
          <UiButton v-if="customProvider" variant="outline" size="icon" :disabled="isAuditMode" aria-label="Provider settings" @click="openSettings">
            <UiIcon name="i-lucide-settings" class="size-4" />
          </UiButton>
          <AddAccountDialog
            v-if="providerMeta"
            :initial-provider="providerMeta.key"
            :readonly="isAuditMode"
            trigger-class="flex-1 sm:w-auto sm:flex-none"
            @connected="onConnected"
          />
        </div>
      </div>
    </div>

    <DataNotice :error="error" />

    <section v-if="!isLoadingAccounts && accounts.length === 0 && supportedModels.length" class="scroll-mt-24 space-y-4 md:space-y-2">
      <div class="pt-1">
        <div class="flex flex-wrap gap-1.5">
          <UiBadge
            v-for="model in orderedSupportedModels"
            :key="model"
            variant="secondary"
            :class="freeModels === null || freeModels.has(model) ? 'text-xs font-normal' : 'text-xs font-normal opacity-40'"
          >
            {{ model }}
          </UiBadge>
        </div>
      </div>
    </section>
    <section v-else-if="accounts.length > 0" class="scroll-mt-24 space-y-4 md:space-y-2">
      <div v-if="supportsProviderQuota && quotaSummaryGroups.length > 0" class="space-y-2 pb-2 md:mb-4 md:rounded-xl md:border md:border-border md:bg-card md:p-4">
        <div class="grid gap-x-6 gap-y-3 md:grid-cols-[repeat(var(--quota-summary-columns),minmax(0,1fr))]" :style="{ '--quota-summary-columns': quotaSummaryGroups.length }">
          <div v-for="group in quotaSummaryGroups" :key="group.name" class="space-y-1.5">
            <div class="flex items-start justify-between gap-2 text-xs">
              <div class="flex min-w-0 items-center gap-1.5">
                <p class="truncate font-medium text-foreground">{{ group.displayName }}</p>
                <span class="shrink-0 text-[10px] text-muted-foreground">{{ group.accounts }} account{{ group.accounts === 1 ? '' : 's' }}</span>
              </div>
              <span class="font-mono text-xs text-muted-foreground">{{ percentLeft(group) }}%</span>
            </div>
            <div class="h-1.5 overflow-hidden rounded-full bg-muted">
              <div class="h-full transition-all duration-300" :class="barColor(group)" :style="{ width: `${percentLeft(group)}%` }" />
            </div>
          </div>
        </div>
      </div>

      <div class="web-card-grid">
        <ProviderAccountCard
          v-for="account in accounts"
          :id="account.id"
          :key="account.id"
          ref="accountCardRefs"
          :account="withStats(account)"
          :data-account-id="account.id"
          class="[contain-intrinsic-size:auto_30rem] [content-visibility:auto]"
          :visible="visibleAccountIds.has(account.id)"
          :show-tier="providerMeta?.showTier"
          :supported-models="supportedByAccount[account.id] ?? supportedModels"
          :disabled-models="disabledModels[account.id] ?? []"
          :model-health="healthByAccount[account.id] ?? {}"
          :error-history="historyById[account.id] ?? null"
          :error-history-error="historyError[account.id] ?? null"
          :quota-info="quotaById[account.id] ?? null"
          :quota-error="errorById[account.id] ?? null"
          :highlight="highlightedAccountIds.has(account.id)"
          :animate-deltas="deltaReady[account.id] === true"
          :readonly="isAuditMode"
          @renamed="onRenamed"
          @active-updated="onActive"
          @temporarily-disabled="onActive"
          @deleted="onDeleted"
          @errors-resolved="onResolved"
        />
      </div>
    </section>

    <UiDialog v-model:open="settingsOpen" ui.content="sm:max-w-xl">
      <h3 class="text-lg font-semibold">Settings</h3>
      <div v-if="settingsForm" class="min-h-0 flex-1 space-y-4 overflow-y-auto">
        <div v-if="settingsError" class="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {{ settingsError }}
        </div>
        <label class="grid gap-1.5">
          <span class="text-xs font-medium text-foreground">Name</span>
          <input v-model="settingsForm.name" class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
        </label>
        <label class="grid gap-1.5">
          <span class="text-xs font-medium text-foreground">Base URL</span>
          <input v-model="settingsForm.baseUrl" class="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
        </label>
        <div class="grid gap-2">
          <span class="text-xs font-medium text-foreground">Headers</span>
          <div v-for="(header, index) in settingsForm.headers" :key="index" class="flex items-center gap-2">
            <input v-model="header.key" class="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" list="provider-settings-header-names" placeholder="Header">
            <input v-model="header.value" class="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" placeholder="Value">
          </div>
          <datalist id="provider-settings-header-names">
            <option v-for="headerName in COMMON_HEADER_NAMES" :key="headerName" :value="headerName" />
          </datalist>
        </div>
        <label class="flex items-center justify-between">
          <span class="text-xs font-medium text-foreground">Enabled</span>
          <UiSwitch v-model="settingsForm.enabled" />
        </label>

        <div class="grid gap-2 border-t border-border pt-3">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-foreground">Models ({{ filledSettingsModels.length }})</span>
            <UiTooltip text="Refresh">
              <UiButton size="icon-sm" variant="outline" :disabled="settingsBusy === 'model-sync'" @click="syncModels">
                <UiIcon name="i-lucide-refresh-cw" :class="['size-4', settingsBusy === 'model-sync' ? 'animate-spin' : '']" />
              </UiButton>
            </UiTooltip>
          </div>
          <div v-for="(row, index) in settingsForm.models" :key="index" class="flex items-center gap-2">
            <input v-model="row.model" class="h-9 flex-1 rounded-md border border-input bg-background px-3 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" placeholder="model">
            <div class="min-w-0 flex-1">
              <ModelAliasSelect :model-value="row.alias" :default-id="row.model" @update:model-value="(value: string) => setAlias(row, value)" />
            </div>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <UiButton variant="destructive" class="mr-auto" @click="deleteOpen = true">
          Delete provider
        </UiButton>
        <UiButton variant="outline" @click="settingsOpen = false">
          Cancel
        </UiButton>
        <UiButton :disabled="settingsBusy === 'save'" @click="saveSettings">
          {{ settingsBusy === "save" ? "Saving…" : "Save" }}
        </UiButton>
      </div>
    </UiDialog>

    <UiDialog v-model:open="deleteOpen" ui.content="sm:max-w-md">
      <h3 class="text-lg font-semibold">
        Delete {{ providerMeta?.label }}?
      </h3>
      <p class="text-sm text-muted-foreground">
        The provider, its models, and its accounts will be removed. This cannot be undone.
      </p>
      <p v-if="deleteError" class="text-sm text-destructive">{{ deleteError }}</p>
      <div class="flex justify-end gap-2">
        <UiButton variant="outline" :disabled="deleteBusy" @click="deleteOpen = false">
          Cancel
        </UiButton>
        <UiButton variant="destructive" :disabled="deleteBusy" @click="deleteProvider">
          {{ deleteBusy ? "Deleting…" : "Delete" }}
        </UiButton>
      </div>
    </UiDialog>
  </div>
</template>
