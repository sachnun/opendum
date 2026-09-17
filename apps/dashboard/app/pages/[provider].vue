<script setup lang="ts">
import type { ActionResult, CustomProviderListItem, CustomProviderModelRow, ErrorHistoryResult, ProviderAccountUpdateData, ProviderDetailData, ProviderDetailDeltaData, ProviderDetailResponse, ProviderStats, QuotaGroupDisplay, QuotaProviderKey } from "../../lib/api-types";
import { BY_KEY, getProviderFromSlug, QUOTA_PROVIDER_KEYS, type ProviderAccountKey } from "../../lib/provider-accounts";
import { COMMON_HEADER_NAMES } from "../../lib/headers";
import { requestErrorMessage } from "../../lib/utils";
import { warmIdbStore } from "../utils/idb";

definePageMeta({
  middleware: ["provider", "auth"],
  layout: "dashboard",
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
const routeProvider = computed(() => String(route.params.provider));
const selectedProvider = computed<string>(() => getProviderFromSlug(routeProvider.value) ?? routeProvider.value);
const { data: customProvidersData, refresh: refreshCustomProviders } = useCachedData(dataKeys.customProviders, () => api.customProviders.list());
const customProvider = computed<CustomProviderListItem | null>(() => (customProvidersData.value ?? []).find((row) => row.slug === selectedProvider.value) ?? null);
const providerMeta = computed<ProviderMeta | null>(() => {
  const builtin = BY_KEY[selectedProvider.value as ProviderAccountKey];
  if (builtin) return { key: builtin.key, slug: builtin.slug, label: builtin.label, showTier: builtin.showTier };
  const custom = customProvider.value;
  if (custom) return { key: custom.slug, slug: custom.slug, label: custom.name, showTier: false };
  return null;
});
const providerSlug = computed(() => providerMeta.value?.slug ?? selectedProvider.value);
const providerNotFound = computed(() => !providerMeta.value && customProvidersData.value !== undefined);

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
const ACCOUNT_STATS_BATCH_SIZE = 24;
const ERROR_HISTORY_BATCH_SIZE = 20;
const ACCOUNT_STATS_POLL_MS = 30_000;
const ACCOUNT_STATS_ROOT_MARGIN = "600px 0px";
const QUOTA_AUTO_LOAD_DELAY_MS = 400;
const PROVIDER_DETAIL_REFRESH_MS = 30_000;
const DASHBOARD_CACHE_DB_NAME = "opendum-dashboard";
const ACCOUNT_STATS_STORE_NAME = "account-stats";
const ACCOUNT_QUOTA_STORE_NAME = "account-quota";
const HIGHLIGHT_DURATION_MS = 2500;

const { data, error, pending, refresh } = useCachedData(
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
const accountStatsById = shallowReactive<Record<string, ProviderStats>>({});
const accountStatsCursorById = ref<Record<string, string>>({});
const accountStatsDeltaReadyById = ref<Record<string, boolean>>({});
const accountStatsFetchedById = ref<Record<string, boolean>>({});
const hydratedAccountStatsIds = ref<Record<string, boolean>>({});
const errorHistoryByAccountId = ref<Record<string, ErrorHistoryEntry[] | null>>({});
const errorHistoryErrorByAccountId = ref<Record<string, string | null>>({});
const errorHistoryFetchedById = ref<Record<string, boolean>>({});
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
let providerDetailRefreshTimer: ReturnType<typeof setInterval> | null = null;
let accountStatsQueueTimer: ReturnType<typeof setTimeout> | null = null;
let errorHistoryQueueTimer: ReturnType<typeof setTimeout> | null = null;
let accountStatsPollTimer: ReturnType<typeof setInterval> | null = null;
let accountsObserver: IntersectionObserver | null = null;
let providerDetailRefreshInFlight: Promise<void> | null = null;
let providerDetailRefreshQueued = false;
let providerDetailRefreshQueuedShouldRefreshQuota = false;
let providerQuotaRefreshInFlight: Promise<void> | null = null;
let shouldPromoteNextNewAccount = false;
const queuedAccountStatsIds = new Set<string>();
const forceQueuedAccountStatsIds = new Set<string>();
const loadingAccountStatsIds = new Set<string>();
const queuedErrorHistoryIds = new Set<string>();
const loadingErrorHistoryIds = new Set<string>();
const accounts = computed(() => {
  const currentAccounts = detailData.value?.accounts ?? [];
  return [...currentAccounts].sort(compareDisplayAccounts);
});
const activeAccountCount = computed(() => accounts.value.filter((account) => account.isActive).length);
const isLoadingAccounts = computed(() => pending.value || (!detailData.value && !error.value));
const pinnedProviders = computed(() => new Set(detailData.value?.pinnedProviders ?? []));
const supportedModels = computed(() => detailData.value?.supportedModels ?? []);
const supportedModelsByAccountId = computed(() => detailData.value?.supportedModelsByAccountId ?? {});
const freeSupportedModels = computed(() => detailData.value?.freeSupportedModels ?? []);
const freeSupportedModelIds = computed<Set<string> | null>(() => (detailData.value ? new Set(freeSupportedModels.value) : null));
const orderedSupportedModels = computed(() => {
  const freeIds = freeSupportedModelIds.value;
  if (!freeIds) return supportedModels.value;

  const free: string[] = [];
  const restricted: string[] = [];
  for (const model of supportedModels.value) {
    (freeIds.has(model) ? free : restricted).push(model);
  }
  return [...free, ...restricted];
});
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
    queueAccountStatsLoad(Array.from(intersectingAccountIds), { force: true });
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
    }, HIGHLIGHT_DURATION_MS);
  },
  { immediate: true }
);

watch(selectedProvider, () => {
  accountDisplayOrder.value = {};
  highlightedAccountIds.value = new Set();
  promotedAccountIds.value = new Set();
  for (const accountId of Object.keys(accountStatsById)) Reflect.deleteProperty(accountStatsById, accountId);
  visibleAccountIds.clear();
  intersectingAccountIds.clear();
  accountStatsCursorById.value = {};
  accountStatsDeltaReadyById.value = {};
  accountStatsFetchedById.value = {};
  hydratedAccountStatsIds.value = {};
  errorHistoryByAccountId.value = {};
  errorHistoryErrorByAccountId.value = {};
  errorHistoryFetchedById.value = {};
  previousLastErrorAtById.value = {};
  queuedAccountStatsIds.clear();
  forceQueuedAccountStatsIds.clear();
  loadingAccountStatsIds.clear();
  queuedErrorHistoryIds.clear();
  loadingErrorHistoryIds.clear();
  if (accountStatsQueueTimer) {
    clearTimeout(accountStatsQueueTimer);
    accountStatsQueueTimer = null;
  }
  if (errorHistoryQueueTimer) {
    clearTimeout(errorHistoryQueueTimer);
    errorHistoryQueueTimer = null;
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
  const clearedSupportedModelIds = new Set(detail.clearedSupportedModelsByAccountId ?? []);
  const clearedDisabledModelIds = new Set(detail.clearedDisabledModelsByAccountId ?? []);
  const clearedModelHealthIds = new Set(detail.clearedModelHealthByAccountId ?? []);
  const nextSupportedModelsByAccountId = {
    ...Object.fromEntries(Object.entries(current.supportedModelsByAccountId).filter(([accountId]) => !clearedSupportedModelIds.has(accountId))),
    ...(detail.supportedModelsByAccountId ?? {}),
  };
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
    freeSupportedModels: detail.freeSupportedModels ?? current.freeSupportedModels,
    supportedModelsByAccountId: nextSupportedModelsByAccountId,
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
    ? await api.accounts.byProviderDetailedDelta({ provider: selectedProvider.value, cursor })
    : await api.accounts.byProviderDetailed({ provider: selectedProvider.value }));
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
    }, HIGHLIGHT_DURATION_MS);

    await nextTick();
    const accountCard = accountCardRefs.value.find((card) => {
      if (card instanceof Element) return card.getAttribute("data-account-id") === accountId;
      return card.accountId === accountId || card.$el?.getAttribute("data-account-id") === accountId;
    });
    const accountElement = accountCard instanceof Element ? accountCard : accountCard?.$el;
    accountElement?.scrollIntoView({ block: "center", behavior: "smooth" });

    setTimeout(() => {
      if (route.path === `/${providerSlug.value}` && decodeAccountHash(route.hash) === accountId) {
        if (typeof window !== "undefined") {
          window.history.replaceState(window.history.state, "", route.path);
        }
      }
    }, 60);
  },
  { immediate: true }
);

const quotaCapableAccounts = computed(() => accounts.value.filter((account) => account.provider === selectedProvider.value && toQuotaProvider(account.provider)));
const activeQuotaAccounts = computed(() => quotaCapableAccounts.value.filter((account) => account.isActive));
let previousQuotaAccountKeys = new Set<string>();
let previousQuotaAccountStates = new Map<string, QuotaAccountState>();
let previousQuotaProvider: string | null = null;
const {
  quotaByAccountId,
  quotaErrorByAccountId,
  cancelQuotaQueue,
  hydrateQuotaCache,
  pruneQuotaState,
  runQuotaQueue,
  waitForQuotaQueue,
} = useQuotaMonitor({
  accounts,
  quotaCapableAccounts,
  toQuotaProvider,
});
const { sessions: freebuffSessions } = useFreebuffSessions(accounts);

onBeforeUnmount(() => {
  if (highlightTimer) clearTimeout(highlightTimer);
  if (accountStatsQueueTimer) clearTimeout(accountStatsQueueTimer);
  if (errorHistoryQueueTimer) clearTimeout(errorHistoryQueueTimer);
  accountsObserver?.disconnect();
  accountsObserver = null;
  stopAccountStatsPolling();
  stopProviderDetailRefresh();
  cancelQuotaQueue();
});

onMounted(() => {
  void warmIdbStore(DASHBOARD_CACHE_DB_NAME, ACCOUNT_STATS_STORE_NAME);
  void warmIdbStore(DASHBOARD_CACHE_DB_NAME, ACCOUNT_QUOTA_STORE_NAME);
  startProviderDetailRefresh();
  void hydrateAccountStatsCache();
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
      queueAccountStatsLoad(visibleIds);
      queueErrorHistoryLoad(visibleIds);
    }
  }, { rootMargin: ACCOUNT_STATS_ROOT_MARGIN });
  observeAccountCards();
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
  const stats = accountStatsById[account.id] ?? account.stats;
  return stats === account.stats ? account : { ...account, stats };
}

async function hydrateAccountStatsCache() {
  if (!import.meta.client) return;

  const accountsToHydrate = accounts.value.filter((account) => !hydratedAccountStatsIds.value[account.id]);
  if (accountsToHydrate.length === 0) return;

  const cachedStats = await readStatsCache(accountsToHydrate.map((account) => account.id));
  const nextHydratedIds = { ...hydratedAccountStatsIds.value };

  for (const [index, cached] of cachedStats.entries()) {
    const account = accountsToHydrate[index];
    if (!account) continue;

    nextHydratedIds[account.id] = true;
    if (!cached || cached.accountId !== account.id) continue;
    if (accountStatsById[account.id]) continue;

    accountStatsById[account.id] = cached.stats;
  }

  for (const account of accountsToHydrate) nextHydratedIds[account.id] = true;
  hydratedAccountStatsIds.value = nextHydratedIds;
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

function queueErrorHistoryLoad(accountIds: Iterable<string>, options: { force?: boolean } = {}) {
  if (!import.meta.client) return;

  for (const accountId of accountIds) {
    if (!options.force && errorHistoryFetchedById.value[accountId]) continue;
    if (loadingErrorHistoryIds.has(accountId)) continue;
    queuedErrorHistoryIds.add(accountId);
  }

  if (queuedErrorHistoryIds.size === 0 || errorHistoryQueueTimer) return;
  errorHistoryQueueTimer = setTimeout(() => {
    errorHistoryQueueTimer = null;
    void flushQueuedErrorHistory();
  }, 80);
}

async function flushQueuedErrorHistory() {
  const accountIds = Array.from(queuedErrorHistoryIds).slice(0, ERROR_HISTORY_BATCH_SIZE);
  for (const accountId of accountIds) queuedErrorHistoryIds.delete(accountId);

  await loadErrorHistories(accountIds);

  if (queuedErrorHistoryIds.size > 0) {
    errorHistoryQueueTimer = setTimeout(() => {
      errorHistoryQueueTimer = null;
      void flushQueuedErrorHistory();
    }, 80);
  }
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

function observeAccountCards() {
  if (!import.meta.client || !accountsObserver) return;
  const root = providerRoot.value;
  if (!root) return;

  accountsObserver.disconnect();
  intersectingAccountIds.clear();

  for (const element of root.querySelectorAll<HTMLElement>("[data-account-id]")) {
    accountsObserver.observe(element);
  }
}

function startAccountStatsPolling() {
  if (!import.meta.client || accountStatsPollTimer) return;

  accountStatsPollTimer = setInterval(() => {
    if (document.hidden) return;
    const accountIds = Array.from(intersectingAccountIds);
    queueAccountStatsLoad(accountIds, { force: true });
    queueErrorHistoryLoad(accountIds, { force: true });
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
    const response = await api.accounts.stats({
      accountIds: requestedAccountIds,
      cursors: Object.fromEntries(requestedAccountIds.map((accountId) => [accountId, accountStatsCursorById.value[accountId] ?? ""])),
    });
    const stats = response.stats ?? {};
    const nextDeltaReadyById = { ...accountStatsDeltaReadyById.value };
    const nextFetchedById = { ...accountStatsFetchedById.value };
    const nextCursorById = { ...accountStatsCursorById.value, ...response.cursors };

    for (const accountId of requestedAccountIds) {
      nextDeltaReadyById[accountId] = Boolean(accountStatsById[accountId] || accountStatsDeltaReadyById.value[accountId]);
      nextFetchedById[accountId] = true;
    }

    for (const [accountId, stat] of Object.entries(stats)) accountStatsById[accountId] = stat;
    accountStatsCursorById.value = nextCursorById;
    accountStatsDeltaReadyById.value = nextDeltaReadyById;
    accountStatsFetchedById.value = nextFetchedById;
    void writeStatsCache(stats);
  } catch (error) {
    console.error("Failed to load account stats:", error);
  } finally {
    for (const accountId of requestedAccountIds) loadingAccountStatsIds.delete(accountId);
  }
}

async function loadErrorHistories(accountIds: string[]) {
  const availableAccountIds = new Set(accounts.value.map((account) => account.id));
  const requestedAccountIds = Array.from(new Set(accountIds))
    .filter((accountId) => availableAccountIds.has(accountId))
    .filter((accountId) => !loadingErrorHistoryIds.has(accountId));

  if (requestedAccountIds.length === 0) return;

  for (const accountId of requestedAccountIds) loadingErrorHistoryIds.add(accountId);

  try {
    const response = await api.accounts.errorHistories({ accountIds: requestedAccountIds, limit: 100 });
    const nextHistoryById = { ...errorHistoryByAccountId.value };
    const nextErrorById = { ...errorHistoryErrorByAccountId.value };
    const nextFetchedById = { ...errorHistoryFetchedById.value };

    if (!response.success) throw new Error(response.error);

    for (const accountId of requestedAccountIds) {
      const result = response.data[accountId];
      nextFetchedById[accountId] = true;
      if (!result?.success) {
        nextHistoryById[accountId] = [];
        nextErrorById[accountId] = null;
        continue;
      }

      nextHistoryById[accountId] = result.data.entries;
      nextErrorById[accountId] = null;
    }

    errorHistoryByAccountId.value = nextHistoryById;
    errorHistoryErrorByAccountId.value = nextErrorById;
    errorHistoryFetchedById.value = nextFetchedById;
  } catch (error) {
    console.error("Failed to load account error histories:", error);
    errorHistoryByAccountId.value = { ...errorHistoryByAccountId.value, ...Object.fromEntries(requestedAccountIds.map((accountId) => [accountId, []])) };
    errorHistoryErrorByAccountId.value = { ...errorHistoryErrorByAccountId.value, ...Object.fromEntries(requestedAccountIds.map((accountId) => [accountId, null])) };
    errorHistoryFetchedById.value = { ...errorHistoryFetchedById.value, ...Object.fromEntries(requestedAccountIds.map((accountId) => [accountId, true])) };
  } finally {
    for (const accountId of requestedAccountIds) loadingErrorHistoryIds.delete(accountId);
  }
}

function pruneAccountStats() {
  const availableAccountIds = new Set(accounts.value.map((account) => account.id));
  for (const accountId of Object.keys(accountStatsById)) {
    if (!availableAccountIds.has(accountId)) Reflect.deleteProperty(accountStatsById, accountId);
  }
  accountStatsCursorById.value = Object.fromEntries(Object.entries(accountStatsCursorById.value).filter(([accountId]) => availableAccountIds.has(accountId)));
  accountStatsDeltaReadyById.value = Object.fromEntries(Object.entries(accountStatsDeltaReadyById.value).filter(([accountId]) => availableAccountIds.has(accountId)));
  accountStatsFetchedById.value = Object.fromEntries(Object.entries(accountStatsFetchedById.value).filter(([accountId]) => availableAccountIds.has(accountId)));
  hydratedAccountStatsIds.value = Object.fromEntries(Object.entries(hydratedAccountStatsIds.value).filter(([accountId]) => availableAccountIds.has(accountId)));
  for (const accountId of forceQueuedAccountStatsIds) {
    if (!availableAccountIds.has(accountId)) forceQueuedAccountStatsIds.delete(accountId);
  }
  for (const accountId of visibleAccountIds) {
    if (!availableAccountIds.has(accountId)) visibleAccountIds.delete(accountId);
  }
  for (const accountId of intersectingAccountIds) {
    if (!availableAccountIds.has(accountId)) intersectingAccountIds.delete(accountId);
  }
}

function pruneErrorHistories() {
  const availableAccountIds = new Set(accounts.value.map((account) => account.id));
  errorHistoryByAccountId.value = Object.fromEntries(Object.entries(errorHistoryByAccountId.value).filter(([accountId]) => availableAccountIds.has(accountId)));
  errorHistoryErrorByAccountId.value = Object.fromEntries(Object.entries(errorHistoryErrorByAccountId.value).filter(([accountId]) => availableAccountIds.has(accountId)));
  errorHistoryFetchedById.value = Object.fromEntries(Object.entries(errorHistoryFetchedById.value).filter(([accountId]) => availableAccountIds.has(accountId)));
}

watch(
  accounts,
  () => {
    pruneAccountStats();
    pruneErrorHistories();
    void hydrateAccountStatsCache();
  },
  { immediate: true }
);

watch(
  () => accounts.value.map((account) => account.id).sort().join("|"),
  async () => {
    await nextTick();
    observeAccountCards();
  },
  { immediate: true }
);

const previousLastErrorAtById = ref<Record<string, number>>({});

watch(
  () => accounts.value.map((account) => `${account.id}:${toTimeMs(account.lastErrorAt)}`).join("|"),
  () => {
    const previousByAccountId = previousLastErrorAtById.value;
    const changedAccountIds: string[] = [];
    const nextByAccountId: Record<string, number> = {};

    for (const account of accounts.value) {
      const lastErrorMs = toTimeMs(account.lastErrorAt);
      nextByAccountId[account.id] = lastErrorMs;

      const previousMs = previousByAccountId[account.id];
      if (previousMs === undefined || lastErrorMs > previousMs) {
        changedAccountIds.push(account.id);
      }
    }

    previousLastErrorAtById.value = nextByAccountId;

    if (changedAccountIds.length > 0) {
      queueErrorHistoryLoad(changedAccountIds, { force: true });
    }
  }
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
  invalidation.patchProviderAccount(selectedProvider.value, account.id, { name: account.name });
  invalidation.patchAccountNameInOptions(account.id, account.name);
}

function handleAccountActiveUpdated(account: ProviderAccountUpdateData) {
  invalidation.patchProviderAccount(selectedProvider.value, account.id, account);
  void invalidation.invalidateAccountOverview();
  invalidation.clearAccountDependentOptions();
  invalidation.clearModelAvailability();
}

function handleAccountDeleted(accountId: string) {
  invalidation.removeProviderAccount(selectedProvider.value, accountId);
  void invalidation.invalidateAccountOverview();
  invalidation.clearAccountDependentOptions();
  invalidation.clearModelAvailability();
}

function handleAccountErrorsResolved(accountId: string) {
  errorHistoryByAccountId.value = { ...errorHistoryByAccountId.value, [accountId]: [] };
  errorHistoryErrorByAccountId.value = { ...errorHistoryErrorByAccountId.value, [accountId]: null };
  errorHistoryFetchedById.value = { ...errorHistoryFetchedById.value, [accountId]: true };
  void refresh();
  void invalidation.invalidateAccountOverview();
}

function handleAccountConnected(result: { provider: string; isUpdate: boolean }) {
  if (result.provider === selectedProvider.value && !result.isUpdate) shouldPromoteNextNewAccount = true;
}

const settingsOpen = ref(false);
const settingsForm = ref<SettingsForm | null>(null);
const settingsBusy = ref("");
const settingsError = ref("");
const customModels = computed<CustomProviderModelRow[]>(() => customProvider.value?.models ?? []);
const filledSettingsModels = computed(() => (settingsForm.value?.models ?? []).filter((row) => row.model.trim() !== ""));

function modelRowFromCustom(model: CustomProviderModelRow): ModelRow {
  const upstream = model.upstream ?? "";
  const source = upstream || model.modelId;
  return { model: source, alias: model.modelId === source ? "" : model.modelId };
}

function openSettings() {
  const custom = customProvider.value;
  if (!custom) return;
  settingsForm.value = {
    name: custom.name,
    baseUrl: custom.baseUrl,
    headers: Object.entries(custom.extraHeaders ?? {}).map(([key, value]) => ({ key, value })),
    models: custom.models.map(modelRowFromCustom),
    enabled: custom.enabled,
  };
  settingsError.value = "";
  settingsOpen.value = true;
}

watch(() => settingsForm.value?.headers, (rows) => {
  if (!rows) return;
  for (let index = rows.length - 2; index >= 0; index--) {
    if (rows[index].key.trim() === "") rows.splice(index, 1);
  }
  const last = rows[rows.length - 1];
  if (!last || last.key.trim() !== "") rows.push({ key: "", value: "" });
}, { deep: true });

watch(() => settingsForm.value?.models, (rows) => {
  if (!rows) return;
  for (let index = rows.length - 2; index >= 0; index--) {
    if (rows[index].model.trim() === "") rows.splice(index, 1);
  }
  const last = rows[rows.length - 1];
  if (!last || last.model.trim() !== "") rows.push({ model: "", alias: "" });
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

function runSettingsAction(action: () => Promise<ActionResult<unknown>>, key: string) {
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
      settingsError.value = requestErrorMessage(error);
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
  try {
    const updated = await api.customProviders.update({
      slug: key,
      name: form.name.trim() || undefined,
      baseUrl: form.baseUrl.trim() || undefined,
      extraHeaders: headersPayload(form),
      enabled: form.enabled,
    });
    if (!updated.success) throw new Error(updated.error);

    const desired = form.models
      .filter((row) => row.model.trim() !== "")
      .map((row) => ({ modelId: row.alias.trim() || row.model.trim(), upstream: row.model.trim() }));
    const desiredIds = new Set(desired.map((row) => row.modelId));
    for (const model of customModels.value.filter((row) => !desiredIds.has(row.modelId))) {
      const removed = await api.customProviders.deleteModel({ slug: key, modelId: model.modelId });
      if (!removed.success) throw new Error(removed.error);
    }
    if (desired.length > 0) {
      const added = await api.customProviders.addModels({ slug: key, models: desired });
      if (!added.success) throw new Error(added.error);
    }

    await refreshCustomProviders();
    settingsOpen.value = false;
  } catch (error) {
    settingsError.value = requestErrorMessage(error);
  } finally {
    settingsBusy.value = "";
  }
}

async function syncModels() {
  const key = providerMeta.value?.key;
  if (!key || !settingsForm.value) return;
  const ok = await runSettingsAction(() => api.customProviders.syncModels({ slug: key }), "model-sync");
  if (ok && settingsForm.value) settingsForm.value.models = customModels.value.map(modelRowFromCustom);
}

const deleteOpen = ref(false);
const deleteBusy = ref(false);
const deleteError = ref("");

async function deleteProvider() {
  const key = providerMeta.value?.key;
  if (!key) return;
  deleteBusy.value = true;
  deleteError.value = "";
  try {
    const result = await api.customProviders.remove({ slug: key });
    if (!result.success) throw new Error(result.error);
    deleteOpen.value = false;
    settingsOpen.value = false;
    await refreshCustomProviders();
    await navigateTo("/");
  } catch (error) {
    deleteError.value = requestErrorMessage(error);
  } finally {
    deleteBusy.value = false;
  }
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
  <div ref="providerRoot" class="space-y-6">
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
        <div class="flex w-full items-center justify-end gap-2 sm:w-auto">
          <UiButton v-if="customProvider" variant="outline" size="icon" :disabled="isAuditMode" aria-label="Provider settings" @click="openSettings">
            <UiIcon name="i-lucide-settings" class="size-4" />
          </UiButton>
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

    <DataNotice :error="error" />

    <div v-if="providerNotFound" class="rounded-xl border border-dashed border-border p-10 text-center">
      <p class="text-sm font-medium text-foreground">Provider not found</p>
      <UiButton variant="outline" class="mt-4" @click="navigateTo('/')">Back to providers</UiButton>
    </div>

    <section v-else-if="!isLoadingAccounts && accounts.length === 0 && supportedModels.length" class="scroll-mt-24 space-y-4 md:space-y-2">
      <div class="pt-1">
        <div class="flex flex-wrap gap-1.5">
          <UiBadge
            v-for="model in orderedSupportedModels"
            :key="model"
            variant="secondary"
            :class="['text-xs font-normal', freeSupportedModelIds === null || freeSupportedModelIds.has(model) ? '' : 'opacity-40']"
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
          class="[contain-intrinsic-size:auto_30rem] [content-visibility:auto]"
          :visible="visibleAccountIds.has(account.id)"
          :show-tier="providerMeta?.showTier"
          :supported-models="supportedModelsByAccountId[account.id] ?? supportedModels"
          :disabled-models="disabledModelsByAccountId[account.id] ?? []"
          :model-health="modelHealthByAccountId[account.id] ?? {}"
          :error-history="errorHistoryByAccountId[account.id] ?? null"
          :error-history-error="errorHistoryErrorByAccountId[account.id] ?? null"
          :quota-info="quotaByAccountId[account.id] ?? null"
          :quota-error="quotaErrorByAccountId[account.id] ?? null"
          :freebuff-session="freebuffSessions[account.id] ?? null"
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
              <ModelAliasSelect v-model="row.alias" :default-id="row.model" />
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
