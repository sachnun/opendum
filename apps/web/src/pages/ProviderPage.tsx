import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { useLocation, useNavigate, useParams } from "@solidjs/router";
import { compareText } from "@opendum/models/compare";
import { accountPath, BY_KEY, providerOf, QUOTA_PROVIDER_KEYS, type ProviderAccountKey } from "@opendum/providers/provider-accounts";
import type { AccountsData, UsageData } from "@opendum/providers/contract";
import type {
  AccountUpdateData,
  ActionResult,
  CustomListItem,
  CustomModelRow,
  ErrorHistoryResult,
  ProviderDetailData,
  ProviderStats,
  QuotaGroupDisplay,
  QuotaProviderKey,
} from "~/lib/api-types";
import { api } from "~/api";
import { isAuditMode } from "~/lib/audit";
import { COMMON_HEADER_NAMES } from "~/lib/headers";
import { invalidation } from "~/lib/invalidate";
import { createQuotaMonitor } from "~/lib/quota-monitor";
import { useLiveEvent } from "~/lib/live-event";
import { createQuery } from "~/lib/query";
import { dataKeys } from "~/lib/data-keys";
import { parentRoute } from "~/lib/routes";
import { decodeHash, settle } from "~/lib/settle";
import { messageOf } from "~/lib/utils";
import { AddAccountDialog } from "~/components/account/AddAccountDialog";
import { ProviderAccountCard } from "~/components/account/ProviderAccountCard";
import { ProviderPinButton } from "~/components/account/ProviderPinButton";
import { DataNotice } from "~/components/common/DataNotice";
import { ModelAliasSelect } from "~/components/model/ModelAliasSelect";
import { UiBadge } from "~/components/ui/UiBadge";
import { UiButton } from "~/components/ui/UiButton";
import { UiDialog } from "~/components/ui/UiDialog";
import { UiIcon } from "~/components/ui/UiIcon";
import { UiSwitch } from "~/components/ui/UiSwitch";
import { UiTooltip } from "~/components/ui/UiTooltip";

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
type QuotaAccountState = { provider: string; isActive: boolean };

const QUOTA_PROVIDERS = new Set<string>(QUOTA_PROVIDER_KEYS);
const STATS_BATCH_SIZE = 24;
const HISTORY_BATCH_SIZE = 20;
const STATS_ROOT_MARGIN = "600px 0px";
const QUOTA_DELAY_MS = 400;
const HIGHLIGHT_DURATION_MS = 2500;

const INPUT_CLASS =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function timeOf(value: string | Date | null | undefined): number {
  if (!value) return 0;
  const timeMs = new Date(value).getTime();
  return Number.isNaN(timeMs) ? 0 : timeMs;
}

export function ProviderPage(): JSX.Element {
  const params = useParams<{ provider: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const routeProvider = () => String(params.provider ?? "");
  const selectedProvider = () => providerOf(routeProvider()) ?? routeProvider();

  const customProvidersQuery = createQuery<CustomListItem[]>(dataKeys.customProviders, () => api.customProviders.list(), {
    defaultValue: [],
  });

  const detailQuery = createQuery<ProviderDetailData>(
    dataKeys.accountsDetail(selectedProvider()),
    () => api.accounts.byProviderDetailed({ provider: selectedProvider() }),
    { defaultValue: undefined }
  );

  const customProvider = createMemo<CustomListItem | null>(
    () => (customProvidersQuery.data() ?? []).find((row) => row.slug === selectedProvider()) ?? null
  );

  const providerMeta = createMemo<ProviderMeta | null>(() => {
    const builtin = BY_KEY[selectedProvider() as ProviderAccountKey];
    if (builtin) return { key: builtin.key, slug: builtin.slug, label: builtin.label, showTier: builtin.showTier };
    const custom = customProvider();
    if (custom) return { key: custom.slug, slug: custom.slug, label: custom.name, showTier: false };
    return null;
  });

  const providerSlug = () => providerMeta()?.slug ?? selectedProvider();
  const providerNotFound = createMemo(() => !providerMeta() && customProvidersQuery.data() !== undefined);

  createEffect(
    on(providerNotFound, (value) => {
      if (value) navigate(parentRoute(location.pathname), { replace: true });
    })
  );

  const [accountDisplayOrder, setAccountDisplayOrder] = createSignal<Record<string, number>>({});
  const [highlightedAccountIds, setHighlightedAccountIds] = createSignal(new Set<string>());
  const [promotedAccountIds, setPromotedAccountIds] = createSignal(new Set<string>());
  const [visibleAccountIds, setVisibleAccountIds] = createSignal(new Set<string>());
  const [statsById, setStatsById] = createSignal<Record<string, ProviderStats>>({});
  const [deltaReady, setDeltaReady] = createSignal<Record<string, boolean>>({});
  const [statsFetched, setStatsFetched] = createSignal<Record<string, boolean>>({});
  const [historyById, setHistoryById] = createSignal<Record<string, ErrorHistoryEntry[] | null>>({});
  const [historyError, setHistoryError] = createSignal<Record<string, string | null>>({});
  const [historyFetched, setHistoryFetched] = createSignal<Record<string, boolean>>({});
  const [prevErrorAt, setPrevErrorAt] = createSignal<Record<string, number>>({});

  let providerRoot: HTMLDivElement | undefined;
  let highlightTimer: ReturnType<typeof setTimeout> | null = null;
  let statsTimer: ReturnType<typeof setTimeout> | null = null;
  let historyTimer: ReturnType<typeof setTimeout> | null = null;
  let accountsObserver: IntersectionObserver | null = null;
  let quotaRefreshing: Promise<void> | null = null;
  let shouldPromoteNew = false;
  let prevQuotaKeys = new Set<string>();
  let prevQuotaStates = new Map<string, QuotaAccountState>();
  let previousQuotaProvider: string | null = null;
  const intersectingAccountIds = new Set<string>();
  const queuedStatsIds = new Set<string>();
  const forceStatsIds = new Set<string>();
  const loadingStatsIds = new Set<string>();
  const queuedHistoryIds = new Set<string>();
  const loadingHistoryIds = new Set<string>();

  const detailData = () => detailQuery.data() ?? null;
  const accounts = createMemo(() => {
    const currentAccounts = detailData()?.accounts ?? [];
    return [...currentAccounts].sort(compareAccounts);
  });
  const activeAccountCount = () => accounts().filter((account) => account.isActive).length;
  const isLoadingAccounts = () => detailQuery.pending() || (!detailData() && !detailQuery.error());
  const pinnedProviders = createMemo(() => new Set(detailData()?.pinnedProviders ?? []));
  const supportedModels = () => detailData()?.supportedModels ?? [];
  const supportedByAccount = () => detailData()?.supportedByAccount ?? {};
  const freeSupportedModels = () => detailData()?.freeSupportedModels ?? [];
  const freeModels = createMemo<Set<string> | null>(() => (detailData() ? new Set(freeSupportedModels()) : null));
  const orderedSupportedModels = createMemo(() => {
    const freeIds = freeModels();
    if (!freeIds) return supportedModels();

    const free: string[] = [];
    const restricted: string[] = [];
    for (const model of supportedModels()) (freeIds.has(model) ? free : restricted).push(model);
    return [...free, ...restricted];
  });
  const disabledModels = () => detailData()?.disabledModelsByAccountId ?? {};
  const healthByAccount = () => detailData()?.modelHealthByAccountId ?? {};
  const supportsProviderQuota = () => QUOTA_PROVIDERS.has(selectedProvider());
  const selectedAccountId = () => hashAccount(location.hash);

  const quotaCapableAccounts = createMemo(() =>
    accounts().filter((account) => account.provider === selectedProvider() && quotaOf(account.provider))
  );
  const activeQuotaAccounts = createMemo(() => quotaCapableAccounts().filter((account) => account.isActive));

  const quota = createQuotaMonitor({
    accounts,
    quotaCapableAccounts,
    toQuotaProvider: quotaOf,
  });

  async function refreshQuota() {
    if (!supportsProviderQuota() || quotaRefreshing) return;

    quotaRefreshing = (async () => {
      await quota.waitForQueue();
      const accountsToRefresh = quotaCapableAccounts().filter((account) => account.isActive || quota.quotaById()[account.id]);
      if (accountsToRefresh.length > 0) await quota.runQuotaQueue(accountsToRefresh, { refreshExisting: true });
    })().catch(() => undefined);

    await settle(() => quotaRefreshing as Promise<void>);
    quotaRefreshing = null;
  }

  function quotaOf(provider: string): QuotaProviderKey | null {
    return QUOTA_PROVIDERS.has(provider) ? (provider as QuotaProviderKey) : null;
  }

  function compareAccounts(a: Account, b: Account): number {
    const aPromoted = promotedAccountIds().has(a.id) ? 1 : 0;
    const bPromoted = promotedAccountIds().has(b.id) ? 1 : 0;

    return (
      bPromoted - aPromoted ||
      Number(b.isActive) - Number(a.isActive) ||
      timeOf(b.lastUsedAt) - timeOf(a.lastUsedAt) ||
      timeOf(b.createdAt) - timeOf(a.createdAt) ||
      compareText(b.id, a.id)
    );
  }

  function percentLeft(group: QuotaSummaryGroup): number {
    return Math.max(0, Math.min(100, Math.round(group.remainingFraction * 100)));
  }

  function barColor(group: QuotaSummaryGroup): string {
    const percent = percentLeft(group);
    if (percent <= 10) return "bg-red-500";
    if (percent <= 25) return "bg-orange-500";
    if (percent <= 50) return "bg-yellow-500";
    return "bg-green-500";
  }

  function withStats(account: Account): Account {
    const stats = statsById()[account.id] ?? account.stats;
    return stats === account.stats ? account : { ...account, stats };
  }

  function queueStats(accountIds: Iterable<string>, options: { force?: boolean } = {}) {
    for (const accountId of accountIds) {
      if (!options.force && statsFetched()[accountId]) continue;
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
    for (const accountId of accountIds) {
      if (!options.force && historyFetched()[accountId]) continue;
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
    if (!accountsObserver) return;
    const root = providerRoot;
    if (!root) return;

    accountsObserver.disconnect();
    intersectingAccountIds.clear();

    for (const element of root.querySelectorAll<HTMLElement>("[data-account-id]")) {
      accountsObserver.observe(element);
    }
  }

  async function loadStats(accountIds: string[], options: { force?: boolean } = {}) {
    const availableAccountIds = new Set(accounts().map((account) => account.id));
    const requestedAccountIds = Array.from(new Set(accountIds))
      .filter((accountId) => availableAccountIds.has(accountId))
      .filter((accountId) => !loadingStatsIds.has(accountId))
      .filter((accountId) => options.force || !statsFetched()[accountId]);

    if (requestedAccountIds.length === 0) return;

    for (const accountId of requestedAccountIds) loadingStatsIds.add(accountId);

    const loaded = await settle(() => api.accounts.stats({ accountIds: requestedAccountIds }));
    if (loaded.ok) {
      const stats = loaded.value;
      const nextDelta = { ...deltaReady() };
      const nextFetched = { ...statsFetched() };

      for (const accountId of requestedAccountIds) {
        nextDelta[accountId] = Boolean(statsById()[accountId] || deltaReady()[accountId]);
        nextFetched[accountId] = true;
      }

      setStatsById((current) => ({ ...current, ...stats }));
      setDeltaReady(nextDelta);
      setStatsFetched(nextFetched);
    }
    for (const accountId of requestedAccountIds) loadingStatsIds.delete(accountId);
  }

  async function loadHistories(accountIds: string[]) {
    const availableAccountIds = new Set(accounts().map((account) => account.id));
    const requestedAccountIds = Array.from(new Set(accountIds))
      .filter((accountId) => availableAccountIds.has(accountId))
      .filter((accountId) => !loadingHistoryIds.has(accountId));

    if (requestedAccountIds.length === 0) return;

    for (const accountId of requestedAccountIds) loadingHistoryIds.add(accountId);

    const loaded = await settle(() => api.accounts.errorHistories({ accountIds: requestedAccountIds, limit: 100 }));
    if (loaded.ok && loaded.value.success) {
      const response = loaded.value;
      const nextHistory = { ...historyById() };
      const nextError = { ...historyError() };
      const nextFetched = { ...historyFetched() };

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

      setHistoryById(nextHistory);
      setHistoryError(nextError);
      setHistoryFetched(nextFetched);
    } else {
      setHistoryById((current) => ({
        ...current,
        ...Object.fromEntries(requestedAccountIds.map((accountId) => [accountId, []])),
      }));
      setHistoryError((current) => ({
        ...current,
        ...Object.fromEntries(requestedAccountIds.map((accountId) => [accountId, null])),
      }));
      setHistoryFetched((current) => ({
        ...current,
        ...Object.fromEntries(requestedAccountIds.map((accountId) => [accountId, true])),
      }));
    }
    for (const accountId of requestedAccountIds) loadingHistoryIds.delete(accountId);
  }

  function pruneStats() {
    const availableAccountIds = new Set(accounts().map((account) => account.id));
    setStatsById((current) =>
      Object.fromEntries(Object.entries(current).filter(([accountId]) => availableAccountIds.has(accountId)))
    );
    setDeltaReady((current) =>
      Object.fromEntries(Object.entries(current).filter(([accountId]) => availableAccountIds.has(accountId)))
    );
    setStatsFetched((current) =>
      Object.fromEntries(Object.entries(current).filter(([accountId]) => availableAccountIds.has(accountId)))
    );
    for (const accountId of forceStatsIds) {
      if (!availableAccountIds.has(accountId)) forceStatsIds.delete(accountId);
    }
    setVisibleAccountIds((current) => new Set<string>([...current].filter((accountId) => availableAccountIds.has(accountId))));
    for (const accountId of intersectingAccountIds) {
      if (!availableAccountIds.has(accountId)) intersectingAccountIds.delete(accountId);
    }
  }

  function pruneHistories() {
    const availableAccountIds = new Set(accounts().map((account) => account.id));
    setHistoryById((current) =>
      Object.fromEntries(Object.entries(current).filter(([accountId]) => availableAccountIds.has(accountId)))
    );
    setHistoryError((current) =>
      Object.fromEntries(Object.entries(current).filter(([accountId]) => availableAccountIds.has(accountId)))
    );
    setHistoryFetched((current) =>
      Object.fromEntries(Object.entries(current).filter(([accountId]) => availableAccountIds.has(accountId)))
    );
  }

  createEffect(
    on(accounts, () => {
      pruneStats();
      pruneHistories();
    })
  );

  createEffect(
    on(
      () => accounts().map((account) => account.id).sort().join("|"),
      () => queueMicrotask(observeCards)
    )
  );

  createEffect(
    on(
      () => accounts().map((account) => `${account.id}:${timeOf(account.lastErrorAt)}`).join("|"),
      () => {
        const previousById = prevErrorAt();
        const changedAccountIds: string[] = [];
        const nextById: Record<string, number> = {};

        for (const account of accounts()) {
          const lastErrorMs = timeOf(account.lastErrorAt);
          nextById[account.id] = lastErrorMs;

          const previousMs = previousById[account.id];
          if (previousMs === undefined || lastErrorMs > previousMs) changedAccountIds.push(account.id);
        }

        setPrevErrorAt(nextById);
        if (changedAccountIds.length > 0) queueHistory(changedAccountIds, { force: true });
      }
    )
  );

  createEffect(
    on(
      () => `${selectedProvider()}|${accounts().map((account) => `${account.id}:${account.provider}:${account.isActive}`).join("|")}`,
      () => {
        const providerChanged = previousQuotaProvider !== selectedProvider();
        const quotaKeys = new Set(quotaCapableAccounts().map((account) => `${account.id}:${account.provider}`));
        const quotaStates = new Map(
          quotaCapableAccounts().map((account) => [account.id, { provider: account.provider, isActive: account.isActive }])
        );
        const newQuotaAccounts = quotaCapableAccounts().filter((account) => !prevQuotaKeys.has(`${account.id}:${account.provider}`));
        const reenabledWithoutQuota = quotaCapableAccounts().filter((account) => {
          const previousState = prevQuotaStates.get(account.id);
          return (
            previousState?.provider === account.provider &&
            previousState.isActive === false &&
            account.isActive &&
            !quota.quotaById()[account.id]
          );
        });
        const shouldRefreshExisting = prevQuotaKeys.size === 0 || providerChanged;
        const accountsToFetch = shouldRefreshExisting
          ? quotaCapableAccounts()
          : newQuotaAccounts.length > 0
            ? newQuotaAccounts
            : reenabledWithoutQuota;

        quota.pruneQuotaState();
        quota.cancelQuotaQueue();
        prevQuotaKeys = quotaKeys;
        prevQuotaStates = quotaStates;
        previousQuotaProvider = selectedProvider();

        if (accountsToFetch.length === 0) return;

        let cancelled = false;
        const quotaLoadTimer = setTimeout(() => {
          if (!cancelled) void quota.runQuotaQueue(accountsToFetch, { refreshExisting: shouldRefreshExisting });
        }, QUOTA_DELAY_MS);

        onCleanup(() => {
          cancelled = true;
          clearTimeout(quotaLoadTimer);
          quota.cancelQuotaQueue();
        });
      }
    )
  );

  createEffect(
    on(detailData, (value, previousValue) => {
      if (!value) return;

      const sortedAccounts = [...value.accounts].sort(compareAccounts);
      if (!previousValue || Object.keys(accountDisplayOrder()).length === 0) {
        setAccountDisplayOrder(Object.fromEntries(sortedAccounts.map((account, index) => [account.id, index])));
        if (!previousValue) return;
      }

      const previousAccountIds = new Set(previousValue.accounts.map((account) => account.id));
      const newAccounts = value.accounts.filter((account) => !previousAccountIds.has(account.id));
      if (newAccounts.length === 0) return;
      if (newAccounts.length === value.accounts.length) {
        setAccountDisplayOrder(Object.fromEntries(sortedAccounts.map((account, index) => [account.id, index])));
        setHighlightedAccountIds(new Set<string>());
        setPromotedAccountIds(new Set<string>());
        shouldPromoteNew = false;
        if (highlightTimer) {
          clearTimeout(highlightTimer);
          highlightTimer = null;
        }
        return;
      }

      setHighlightedAccountIds(new Set(newAccounts.map((account) => account.id)));
      if (shouldPromoteNew) {
        setPromotedAccountIds((current) => new Set([...current, ...newAccounts.map((account) => account.id)]));
      }

      const currentOrder = accountDisplayOrder();
      const orderedNewAccounts = [...newAccounts].sort(compareAccounts);
      setAccountDisplayOrder(
        Object.fromEntries([
          ...orderedNewAccounts.map((account, index) => [account.id, index] as const),
          ...Object.entries(currentOrder)
            .filter(([accountId]) => value.accounts.some((account) => account.id === accountId))
            .map(([accountId, order]) => [accountId, order + orderedNewAccounts.length] as const),
        ])
      );

      shouldPromoteNew = false;
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => {
        setHighlightedAccountIds(new Set<string>());
        highlightTimer = null;
      }, HIGHLIGHT_DURATION_MS);
    })
  );

  createEffect(
    on(selectedProvider, () => {
      setAccountDisplayOrder({});
      setHighlightedAccountIds(new Set<string>());
      setPromotedAccountIds(new Set<string>());
      setStatsById({});
      setVisibleAccountIds(new Set<string>());
      intersectingAccountIds.clear();
      setDeltaReady({});
      setStatsFetched({});
      setHistoryById({});
      setHistoryError({});
      setHistoryFetched({});
      setPrevErrorAt({});
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
    })
  );

  function applyAccounts(snapshot: AccountsData): void {
    const detail = snapshot.providers[selectedProvider()];
    if (!detail) return;

    detailQuery.setData(detail);
    queueStats(Array.from(intersectingAccountIds), { force: true });
    void refreshQuota();
  }

  function applyUsage(snapshot: UsageData): void {
    setStatsById((current) => ({ ...current, ...snapshot.accountStats }));
  }

  useLiveEvent("usage", applyUsage);
  useLiveEvent("accounts", applyAccounts);

  createEffect(
    on([accounts, selectedAccountId], ([currentAccounts, accountId]) => {
      if (!accountId || !currentAccounts.some((account) => account.id === accountId)) return;

      setHighlightedAccountIds(new Set<string>([accountId]));
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => {
        setHighlightedAccountIds(new Set<string>());
        highlightTimer = null;
      }, HIGHLIGHT_DURATION_MS);

      queueMicrotask(() => {
        const element = providerRoot?.querySelector<HTMLElement>(`[data-account-id="${accountId}"]`);
        element?.scrollIntoView({ block: "center", behavior: "smooth" });

        setTimeout(() => {
          if (location.pathname === accountPath(providerSlug()) && hashAccount(location.hash) === accountId) {
            window.history.replaceState(window.history.state, "", location.pathname);
          }
        }, 60);
      });
    })
  );

  const quotaSummaryGroups = createMemo<QuotaSummaryGroup[]>(() => {
    const groups = new Map<string, QuotaSummaryGroup>();

    for (const account of activeQuotaAccounts()) {
      const accountQuota = quota.quotaById()[account.id];
      if (accountQuota?.status !== "success") continue;

      for (const group of accountQuota.groups) {
        if (![group.remainingRequests, group.maxRequests, group.usedRequests].every(Number.isFinite) || group.maxRequests <= 0) {
          continue;
        }

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

    return Array.from(groups.values()).map((group) =>
      Object.assign(group, {
        remainingFraction:
          group.maxRequests > 0 ? Math.max(0, Math.min(1, group.remainingRequests / group.maxRequests)) : 0,
        percentUsed:
          group.maxRequests > 0
            ? Math.round(Math.max(0, Math.min(100, (group.usedRequests / group.maxRequests) * 100)))
            : 0,
      })
    );
  });

  function onRenamed(account: AccountUpdateData) {
    invalidation.patchProviderAccount(selectedProvider(), account.id, { name: account.name });
    invalidation.patchName(account.id, account.name);
  }

  function onActive(account: AccountUpdateData) {
    invalidation.patchProviderAccount(selectedProvider(), account.id, account);
    void invalidation.invalidateAccountOverview();
    invalidation.clearOptions();
    void invalidation.clearModelAvailability();
  }

  function onDeleted(accountId: string) {
    invalidation.removeProviderAccount(selectedProvider(), accountId);
    void invalidation.invalidateAccountOverview();
    invalidation.clearOptions();
    void invalidation.clearModelAvailability();
  }

  function onResolved(accountId: string) {
    setHistoryById((current) => ({ ...current, [accountId]: [] }));
    setHistoryError((current) => ({ ...current, [accountId]: null }));
    setHistoryFetched((current) => ({ ...current, [accountId]: true }));
    void detailQuery.refresh();
    void invalidation.invalidateAccountOverview();
  }

  function onConnected(result: { provider: string; isUpdate: boolean }) {
    if (result.provider === selectedProvider() && !result.isUpdate) shouldPromoteNew = true;
  }

  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [settingsForm, setSettingsForm] = createSignal<SettingsForm | null>(null);
  const [settingsBusy, setSettingsBusy] = createSignal("");
  const [settingsError, setSettingsError] = createSignal("");
  const customModels = () => customProvider()?.models ?? [];
  const filledSettingsModels = () => (settingsForm()?.models ?? []).filter((row) => row.model.trim() !== "");

  function customRow(model: CustomModelRow): ModelRow {
    const upstream = model.upstream ?? "";
    const source = upstream || model.modelId;
    return {
      model: source,
      alias: model.modelId === source ? "" : model.modelId,
      aliased: model.aliased || model.modelId !== source,
    };
  }

  function setAlias(row: ModelRow, value: string) {
    row.alias = value;
    row.aliased = value !== "";
    const form = settingsForm();
    if (form) setSettingsForm({ ...form, models: [...form.models] });
  }

  function openSettings() {
    const custom = customProvider();
    if (!custom) return;
    setSettingsForm({
      name: custom.name,
      baseUrl: custom.baseUrl,
      headers: Object.entries(custom.extraHeaders ?? {}).map(([key, value]) => ({ key, value })),
      models: custom.models.map(customRow),
      enabled: custom.enabled,
    });
    setSettingsError("");
    setSettingsOpen(true);
  }

  function updateSettingsHeaders(next: HeaderRow[]) {
    for (let index = next.length - 2; index >= 0; index -= 1) {
      const row = next[index];
      if (row && row.key.trim() === "") next.splice(index, 1);
    }
    const last = next[next.length - 1];
    if (!last || last.key.trim() !== "") next.push({ key: "", value: "" });
    const form = settingsForm();
    if (form) setSettingsForm({ ...form, headers: next });
  }

  function updateSettingsModels(next: ModelRow[]) {
    for (let index = next.length - 2; index >= 0; index -= 1) {
      const row = next[index];
      if (row && row.model.trim() === "") next.splice(index, 1);
    }
    const last = next[next.length - 1];
    if (!last || last.model.trim() !== "") next.push({ model: "", alias: "", aliased: false });
    const form = settingsForm();
    if (form) setSettingsForm({ ...form, models: next });
  }

  function headersPayload(form: SettingsForm): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const row of form.headers) {
      const key = row.key.trim();
      const value = row.value.trim();
      if (key && value) headers[key] = value;
    }
    return headers;
  }

  function runAction(action: () => Promise<ActionResult<unknown>>, key: string): Promise<boolean> {
    setSettingsBusy(key);
    setSettingsError("");
    return action()
      .then(async (result) => {
        if (!result.success) {
          setSettingsError(result.error);
          return false;
        }
        await customProvidersQuery.refresh();
        return true;
      })
      .catch((error) => {
        setSettingsError(messageOf(error));
        return false;
      })
      .finally(() => setSettingsBusy(""));
  }

  async function saveSettings() {
    const form = settingsForm();
    const key = providerMeta()?.key;
    if (!form || !key) return;
    setSettingsBusy("save");
    setSettingsError("");
    const saved = await settle(() =>
      api.customProviders.update({
        slug: key,
        name: form.name.trim() || undefined,
        baseUrl: form.baseUrl.trim() || undefined,
        extraHeaders: headersPayload(form),
        enabled: form.enabled,
      })
    );
    setSettingsBusy("");
    if (!saved.ok) {
      setSettingsError(messageOf(saved.error));
      return;
    }
    if (!saved.value.success) {
      setSettingsError(saved.value.error);
      return;
    }

    const desired = form.models
      .filter((row) => row.model.trim() !== "")
      .map((row) => ({ modelId: row.alias.trim() || row.model.trim(), upstream: row.model.trim(), aliased: row.aliased }));
    const desiredIds = new Set(desired.map((row) => row.modelId));
    for (const model of customModels().filter((row) => !desiredIds.has(row.modelId))) {
      const removed = await api.customProviders.deleteModel({ slug: key, modelId: model.modelId });
      if (!removed.success) {
        setSettingsError(removed.error);
        return;
      }
    }
    if (desired.length > 0) {
      const added = await api.customProviders.addModels({ slug: key, models: desired });
      if (!added.success) {
        setSettingsError(added.error);
        return;
      }
    }

    await customProvidersQuery.refresh();
    setSettingsOpen(false);
  }

  async function syncModels() {
    const key = providerMeta()?.key;
    if (!key || !settingsForm()) return;
    const ok = await runAction(() => api.customProviders.syncModels({ slug: key }), "model-sync");
    const form = settingsForm();
    if (ok && form) setSettingsForm({ ...form, models: customModels().map(customRow) });
  }

  const [deleteOpen, setDeleteOpen] = createSignal(false);
  const [deleteBusy, setDeleteBusy] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal("");

  async function deleteProvider() {
    const key = providerMeta()?.key;
    if (!key) return;
    setDeleteBusy(true);
    setDeleteError("");
    const removed = await settle(() => api.customProviders.remove({ slug: key }));
    setDeleteBusy(false);
    if (!removed.ok) {
      setDeleteError(messageOf(removed.error));
      return;
    }
    if (!removed.value.success) {
      setDeleteError(removed.value.error);
      return;
    }
    setDeleteOpen(false);
    setSettingsOpen(false);
    await customProvidersQuery.refresh();
    navigate(parentRoute(location.pathname));
  }

  function hashAccount(hash: string): string | null {
    const accountId = hash.startsWith("#") ? hash.slice(1) : hash;
    if (!accountId) return null;
    return decodeHash(accountId);
  }

  onMount(() => {
    accountsObserver = new IntersectionObserver(
      (entries) => {
        const visibleIds: string[] = [];

        for (const entry of entries) {
          const accountId = (entry.target as HTMLElement).dataset.accountId;
          if (!accountId) continue;

          if (!entry.isIntersecting) {
            intersectingAccountIds.delete(accountId);
            continue;
          }

          setVisibleAccountIds((current) => new Set(current).add(accountId));
          intersectingAccountIds.add(accountId);
          visibleIds.push(accountId);
        }

        if (visibleIds.length > 0) {
          queueStats(visibleIds);
          queueHistory(visibleIds);
        }
      },
      { rootMargin: STATS_ROOT_MARGIN }
    );

    observeCards();
  });

  onCleanup(() => {
    if (highlightTimer) clearTimeout(highlightTimer);
    if (statsTimer) clearTimeout(statsTimer);
    if (historyTimer) clearTimeout(historyTimer);
    accountsObserver?.disconnect();
    accountsObserver = null;
    quota.cancelQuotaQueue();
  });

  return (
    <div ref={providerRoot} class="space-y-6">
      <div class="web-header-divider">
        <div class="flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 class="inline-flex min-h-9 items-center gap-2 text-xl font-semibold">
            <Show when={providerMeta()}>
              {(meta) => (
                <ProviderPinButton
                  providerKey={meta().key}
                  pinned={pinnedProviders().has(meta().key)}
                  readonly={isAuditMode()}
                  onToggled={() => void detailQuery.refresh()}
                />
              )}
            </Show>
            {providerMeta()?.label ?? selectedProvider().replaceAll("_", " ")}
            <Show when={accounts().length > 0}>
              <UiBadge variant="outline" class="text-xs">
                {activeAccountCount()}/{accounts().length}
              </UiBadge>
            </Show>
          </h2>
          <div class="flex w-full items-center justify-end gap-2 sm:w-auto">
            <Show when={customProvider()}>
              <UiButton
                variant="outline"
                size="icon"
                disabled={isAuditMode()}
                aria-label="Provider settings"
                onClick={openSettings}
              >
                <UiIcon name="i-lucide-settings" class="size-4" />
              </UiButton>
            </Show>
            <Show when={providerMeta()}>
              {(meta) => (
                <AddAccountDialog
                  initialProvider={meta().key}
                  readonly={isAuditMode()}
                  triggerClass="flex-1 sm:w-auto sm:flex-none"
                  onConnected={onConnected}
                  onCustomCreated={() => void customProvidersQuery.refresh()}
                />
              )}
            </Show>
          </div>
        </div>
      </div>

      <DataNotice error={detailQuery.error()} />

      <Show
        when={!isLoadingAccounts() && accounts().length === 0 && supportedModels().length > 0}
        fallback={
          <Show when={accounts().length > 0}>
            <section class="scroll-mt-24 space-y-4 md:space-y-2">
              <Show when={supportsProviderQuota() && quotaSummaryGroups().length > 0}>
                <div class="space-y-2 pb-2 md:mb-4 md:rounded-xl md:border md:border-border md:bg-card md:p-4">
                  <div
                    class="grid gap-x-6 gap-y-3 md:grid-cols-[repeat(var(--quota-summary-columns),minmax(0,1fr))]"
                    style={{ "--quota-summary-columns": quotaSummaryGroups().length }}
                  >
                    <For each={quotaSummaryGroups()}>
                      {(group) => (
                        <div class="space-y-1.5">
                          <div class="flex items-start justify-between gap-2 text-xs">
                            <div class="flex min-w-0 items-center gap-1.5">
                              <p class="truncate font-medium text-foreground">{group.displayName}</p>
                              <span class="shrink-0 text-[10px] text-muted-foreground">
                                {group.accounts} account{group.accounts === 1 ? "" : "s"}
                              </span>
                            </div>
                            <span class="font-mono text-xs text-muted-foreground">{percentLeft(group)}%</span>
                          </div>
                          <div class="h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                              class={`h-full transition-all duration-300 ${barColor(group)}`}
                              style={{ width: `${percentLeft(group)}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              <div class="web-card-grid">
                <For each={accounts()}>
                  {(account) => (
                    <div data-account-id={account.id} class="[contain-intrinsic-size:auto_30rem] [content-visibility:auto]">
                      <ProviderAccountCard
                        account={withStats(account)}
                        visible={visibleAccountIds().has(account.id)}
                        showTier={providerMeta()?.showTier}
                        supportedModels={supportedByAccount()[account.id] ?? supportedModels()}
                        disabledModels={disabledModels()[account.id] ?? []}
                        modelHealth={healthByAccount()[account.id] ?? {}}
                        errorHistory={historyById()[account.id] ?? null}
                        errorHistoryError={historyError()[account.id] ?? null}
                        quotaInfo={quota.quotaById()[account.id] ?? null}
                        quotaError={quota.errorById()[account.id] ?? null}
                        highlight={highlightedAccountIds().has(account.id)}
                        animateDeltas={deltaReady()[account.id] === true}
                        readonly={isAuditMode()}
                        onRenamed={onRenamed}
                        onActiveUpdated={onActive}
                        onTemporarilyDisabled={onActive}
                        onDeleted={onDeleted}
                        onErrorsResolved={onResolved}
                      />
                    </div>
                  )}
                </For>
              </div>
            </section>
          </Show>
        }
      >
        <section class="scroll-mt-24 space-y-4 md:space-y-2">
          <div class="pt-1">
            <div class="flex flex-wrap gap-1.5">
              <For each={orderedSupportedModels()}>
                {(model) => (
                  <UiBadge
                    variant="secondary"
                    class={
                      freeModels() === null || freeModels()?.has(model)
                        ? "text-xs font-normal"
                        : "text-xs font-normal opacity-40"
                    }
                  >
                    {model}
                  </UiBadge>
                )}
              </For>
            </div>
          </div>
        </section>
      </Show>

      <UiDialog
        open={settingsOpen()}
        onOpenChange={setSettingsOpen}
        ui={{ content: "sm:max-w-xl" }}
        content={
          <>
            <h3 class="text-lg font-semibold">Settings</h3>
            <Show when={settingsForm()}>
              {(form) => (
                <div class="min-h-0 flex-1 space-y-4 overflow-y-auto">
                  <Show when={settingsError()}>
                    <div class="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                      {settingsError()}
                    </div>
                  </Show>
                  <label class="grid gap-1.5">
                    <span class="text-xs font-medium text-foreground">Name</span>
                    <input
                      value={form().name}
                      class={INPUT_CLASS}
                      onInput={(event) => setSettingsForm({ ...form(), name: event.currentTarget.value })}
                    />
                  </label>
                  <label class="grid gap-1.5">
                    <span class="text-xs font-medium text-foreground">Base URL</span>
                    <input
                      value={form().baseUrl}
                      class={`${INPUT_CLASS} font-mono`}
                      onInput={(event) => setSettingsForm({ ...form(), baseUrl: event.currentTarget.value })}
                    />
                  </label>
                  <div class="grid gap-2">
                    <span class="text-xs font-medium text-foreground">Headers</span>
                    <For each={form().headers}>
                      {(header, index) => (
                        <div class="flex items-center gap-2">
                          <input
                            value={header.key}
                            class={`${INPUT_CLASS} flex-1`}
                            list="provider-settings-header-names"
                            placeholder="Header"
                            onInput={(event) => {
                              const next = form().headers.map((row, rowIndex) =>
                                rowIndex === index() ? { ...row, key: event.currentTarget.value } : row
                              );
                              updateSettingsHeaders(next);
                            }}
                          />
                          <input
                            value={header.value}
                            class={`${INPUT_CLASS} flex-1`}
                            placeholder="Value"
                            onInput={(event) => {
                              const next = form().headers.map((row, rowIndex) =>
                                rowIndex === index() ? { ...row, value: event.currentTarget.value } : row
                              );
                              updateSettingsHeaders(next);
                            }}
                          />
                        </div>
                      )}
                    </For>
                    <datalist id="provider-settings-header-names">
                      <For each={COMMON_HEADER_NAMES}>{(headerName) => <option value={headerName} />}</For>
                    </datalist>
                  </div>
                  <label class="flex items-center justify-between">
                    <span class="text-xs font-medium text-foreground">Enabled</span>
                    <UiSwitch
                      checked={form().enabled}
                      onCheckedChange={(checked) => setSettingsForm({ ...form(), enabled: checked })}
                    />
                  </label>

                  <div class="grid gap-2 border-t border-border pt-3">
                    <div class="flex items-center justify-between">
                      <span class="text-xs font-medium text-foreground">Models ({filledSettingsModels().length})</span>
                      <UiTooltip text="Refresh">
                        <UiButton
                          size="icon-sm"
                          variant="outline"
                          disabled={settingsBusy() === "model-sync"}
                          onClick={() => void syncModels()}
                        >
                          <UiIcon
                            name="i-lucide-refresh-cw"
                            class={`size-4 ${settingsBusy() === "model-sync" ? "animate-spin" : ""}`}
                          />
                        </UiButton>
                      </UiTooltip>
                    </div>
                    <For each={form().models}>
                      {(row, index) => (
                        <div class="flex items-center gap-2">
                          <input
                            value={row.model}
                            class={`${INPUT_CLASS} flex-1 font-mono`}
                            placeholder="model"
                            onInput={(event) => {
                              const next = form().models.map((entry, entryIndex) =>
                                entryIndex === index() ? { ...entry, model: event.currentTarget.value } : entry
                              );
                              updateSettingsModels(next);
                            }}
                          />
                          <div class="min-w-0 flex-1">
                            <ModelAliasSelect
                              modelValue={row.alias}
                              defaultId={row.model}
                              onValueChange={(value) => setAlias(row, value)}
                            />
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </Show>
            <div class="flex items-center gap-2">
              <UiButton variant="destructive" class="mr-auto" onClick={() => setDeleteOpen(true)}>
                Delete provider
              </UiButton>
              <UiButton variant="outline" onClick={() => setSettingsOpen(false)}>
                Cancel
              </UiButton>
              <UiButton disabled={settingsBusy() === "save"} onClick={() => void saveSettings()}>
                {settingsBusy() === "save" ? "Saving…" : "Save"}
              </UiButton>
            </div>
          </>
        }
      />

      <UiDialog
        open={deleteOpen()}
        onOpenChange={setDeleteOpen}
        ui={{ content: "sm:max-w-md" }}
        content={
          <>
            <h3 class="text-lg font-semibold">Delete {providerMeta()?.label}?</h3>
            <p class="text-sm text-muted-foreground">
              The provider, its models, and its accounts will be removed. This cannot be undone.
            </p>
            <Show when={deleteError()}>
              <p class="text-sm text-destructive">{deleteError()}</p>
            </Show>
            <div class="flex justify-end gap-2">
              <UiButton variant="outline" disabled={deleteBusy()} onClick={() => setDeleteOpen(false)}>
                Cancel
              </UiButton>
              <UiButton variant="destructive" disabled={deleteBusy()} onClick={() => void deleteProvider()}>
                {deleteBusy() ? "Deleting…" : "Delete"}
              </UiButton>
            </div>
          </>
        }
      />
    </div>
  );
}

export default ProviderPage;
