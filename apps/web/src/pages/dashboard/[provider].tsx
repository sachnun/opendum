import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { BY_KEY, getProviderFromSlug, type ProviderAccountKey } from "../../lib/provider-accounts";
import type { ErrorHistoryResult, ProviderDetailData, ProviderStats, QuotaGroupDisplay, QuotaProviderKey } from "../../lib/dashboard-api-types";
import { useDashboardApi } from "../../hooks/useDashboardApi";
import { useDashboardAudit } from "../../hooks/useDashboardAudit";
import { dashboardDataKeys, useDataVersion } from "../../hooks/useDashboardDataInvalidation";
import { useAccountQuotaMonitor } from "../../hooks/useAccountQuotaMonitor";
import { readCachedAccountStats, writeCachedAccountStats } from "../../hooks/useAccountStatsCache";
import { AddAccountDialog } from "../../components/AddAccountDialog";
import { DashboardDataNotice } from "../../components/DashboardDataNotice";
import { ProviderAccountCard } from "../../components/ProviderAccountCard";
import { ProviderPinButton } from "../../components/ProviderPinButton";
import { UiBadge } from "../../components/ui/UiBadge";
import { UiSkeleton } from "../../components/ui/UiSkeleton";

type Account = ProviderDetailData["accounts"][number];
type ErrorHistoryEntry = Extract<ErrorHistoryResult, { success: true }>["data"]["entries"][number];

const QUOTA_PROVIDERS = new Set<string>(["antigravity", "codex", "kiro", "openrouter", "siliconflow", "command_code", "zenmux"]);
const PROVIDER_DETAIL_REFRESH_MS = 30_000;

function toQuotaProvider(provider: string): QuotaProviderKey | null {
  return QUOTA_PROVIDERS.has(provider) ? (provider as QuotaProviderKey) : null;
}

function decodeAccountHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const id = raw.startsWith("account-") ? raw.slice("account-".length) : raw;
  if (!id) return null;
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

export default function ProviderPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const dashboardApi = useDashboardApi();
  const { isAuditMode } = useDashboardAudit();
  const providerSlug = location.pathname.split("/").filter(Boolean).pop() ?? "";
  const selectedProvider = getProviderFromSlug(providerSlug) as ProviderAccountKey;
  const providerMeta = BY_KEY[selectedProvider];

  const detailKey = dashboardDataKeys.accountsDetail(selectedProvider);
  const detailVersion = useDataVersion(detailKey);

  const [detailData, setDetailData] = useState<ProviderDetailData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [accountStatsById, setAccountStatsById] = useState<Record<string, ProviderStats>>({});
  const [accountStatsCursorById, setAccountStatsCursorById] = useState<Record<string, string>>({});
  const [errorHistoryByAccountId, setErrorHistoryByAccountId] = useState<Record<string, ErrorHistoryEntry[] | null>>({});
  const [errorHistoryErrorByAccountId, setErrorHistoryErrorByAccountId] = useState<Record<string, string | null>>({});
  const [highlightedAccountIds, setHighlightedAccountIds] = useState<Set<string>>(new Set());
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadDetail = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await dashboardApi.accounts.byProviderDetailed({ provider: selectedProvider });
      setDetailData(data);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setIsLoading(false);
    }
  }, [dashboardApi, selectedProvider]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail, detailVersion]);

  useEffect(() => {
    const timer = setInterval(() => void loadDetail(), PROVIDER_DETAIL_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadDetail]);

  const accounts = useMemo(() => {
    const current = detailData?.accounts ?? [];
    return [...current].sort((a, b) => {
      const aActive = a.isActive ? 0 : 1;
      const bActive = b.isActive ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [detailData]);

  const activeAccountCount = accounts.filter((account) => account.isActive).length;
  const pinnedProviders = useMemo(() => new Set(detailData?.pinnedProviders ?? []), [detailData]);
  const supportedModels = detailData?.supportedModels ?? [];
  const supportedModelsByAccountId = detailData?.supportedModelsByAccountId ?? {};
  const disabledModelsByAccountId = detailData?.disabledModelsByAccountId ?? {};
  const modelHealthByAccountId = detailData?.modelHealthByAccountId ?? {};
  const supportsProviderQuota = QUOTA_PROVIDERS.has(selectedProvider);

  // Account stats
  useEffect(() => {
    const accountIds = accounts.map((account) => account.id);
    if (accountIds.length === 0) return;
    void (async () => {
      const cached = await readCachedAccountStats(accountIds);
      const next: Record<string, ProviderStats> = {};
      for (const [index, entry] of cached.entries()) {
        if (entry && accountIds[index] === entry.accountId) next[entry.accountId] = entry.stats;
      }
      if (Object.keys(next).length > 0) setAccountStatsById((current) => ({ ...current, ...next }));
    })();
    void (async () => {
      try {
        const response = await dashboardApi.accounts.stats({ accountIds, cursors: accountStatsCursorById });
        setAccountStatsCursorById((current) => ({ ...current, ...response.cursors }));
        if (response.stats) {
          setAccountStatsById((current) => ({ ...current, ...response.stats }));
          void writeCachedAccountStats(response.stats);
        }
      } catch (err) {
        console.error("Failed to load account stats:", err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, dashboardApi]);

  // Error history
  useEffect(() => {
    const accountIds = accounts.map((account) => account.id);
    if (accountIds.length === 0) return;
    void (async () => {
      try {
        const result = await dashboardApi.accounts.errorHistories({ accountIds, limit: 20 });
        if (!result.success) return;
        const next: Record<string, ErrorHistoryEntry[] | null> = {};
        for (const [accountId, value] of Object.entries(result.data)) {
          if (value.success) next[accountId] = value.data.entries;
        }
        setErrorHistoryByAccountId(next);
        setErrorHistoryErrorByAccountId({});
      } catch (err) {
        setErrorHistoryErrorByAccountId(Object.fromEntries(accountIds.map((id) => [id, (err as Error).message])));
      }
    })();
  }, [accounts, dashboardApi]);

  // Quota monitor
  const { quotaByAccountId, quotaErrorByAccountId, quotaLoadingByAccountId, runQuotaQueue } = useAccountQuotaMonitor({
    accounts,
    quotaCapableAccounts: accounts.filter((account) => supportsProviderQuota),
    toQuotaProvider,
  });

  useEffect(() => {
    if (!supportsProviderQuota) return;
    const timer = setTimeout(() => {
      void runQuotaQueue(undefined, { refreshExisting: false });
    }, 400);
    return () => clearTimeout(timer);
  }, [supportsProviderQuota, runQuotaQueue, accounts.length]);

  // Hash highlight
  useEffect(() => {
    const raw = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
    if (!raw.startsWith("account-")) return;
    const id = decodeAccountHash(raw);
    if (!id) return;
    setHighlightedAccountIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => {
      setHighlightedAccountIds(new Set());
      highlightTimer.current = null;
    }, 2500);
    navigate(location.pathname, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.hash]);

  // Quota summary groups
  const quotaSummaryGroups = useMemo(() => {
    const groups = new Map<string, { displayName: string; name: string; remainingFraction: number; maxRequests: number; usedRequests: number; accounts: number }>();
    for (const account of accounts) {
      const quota = quotaByAccountId[account.id];
      if (!quota) continue;
      for (const group of quota.groups) {
        const existing = groups.get(group.name);
        if (!existing) {
          groups.set(group.name, { name: group.name, displayName: group.displayName, remainingFraction: 0, maxRequests: 0, usedRequests: 0, accounts: 0 });
        }
        const current = groups.get(group.name)!;
        current.accounts += 1;
        current.remainingFraction = Math.max(current.remainingFraction, group.remainingFraction);
        current.maxRequests = Math.max(current.maxRequests, group.maxRequests);
        current.usedRequests = Math.max(current.usedRequests, group.usedRequests);
      }
    }
    return [...groups.values()];
  }, [quotaByAccountId, accounts]);

  const quotaPercentRemaining = (group: { remainingFraction: number }) => Math.round(group.remainingFraction * 100);
  const quotaBarColor = (group: { remainingFraction: number }) => {
    const percent = quotaPercentRemaining(group);
    if (percent > 50) return "bg-emerald-500";
    if (percent > 20) return "bg-yellow-500";
    return "bg-destructive";
  };

  const handleAccountConnected = () => void loadDetail();
  const handleAccountRenamed = () => void loadDetail();
  const handleAccountActiveUpdated = () => void loadDetail();
  const handleAccountDeleted = () => void loadDetail();
  const handleAccountErrorsResolved = () => void loadDetail();

  const isLoadingAccounts = isLoading || (!detailData && !error);

  return (
    <div className="space-y-6">
      <div className="dashboard-header-divider">
        <div className="flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="inline-flex min-h-9 items-center gap-2 text-xl font-semibold">
            {providerMeta ? <ProviderPinButton providerKey={providerMeta.key} pinned={pinnedProviders.has(providerMeta.key)} readonly={isAuditMode} /> : null}
            {providerMeta?.label ?? selectedProvider.replaceAll("_", " ")}
            {accounts.length > 0 ? <UiBadge variant="outline" className="text-xs">{activeAccountCount}/{accounts.length}</UiBadge> : null}
          </h2>
          <div className="flex w-full items-center sm:w-auto">
            {providerMeta ? (
              <AddAccountDialog initialProvider={providerMeta.key} readonly={isAuditMode} triggerClass="flex-1 sm:w-auto sm:flex-none" onConnected={handleAccountConnected} />
            ) : null}
          </div>
        </div>
      </div>

      <DashboardDataNotice error={error} />

      {!isLoadingAccounts && accounts.length === 0 ? (
        <section className="scroll-mt-24 space-y-4 md:space-y-2">
          <div className="space-y-3 pt-1">
            <p className="text-sm text-muted-foreground">{providerMeta?.emptyMessage ?? "No accounts connected yet."}</p>
            {supportedModels.length ? (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {supportedModels.map((model) => (
                    <UiBadge key={model} variant="secondary" className="text-xs font-normal">{model}</UiBadge>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : accounts.length > 0 ? (
        <section className="scroll-mt-24 space-y-4 md:space-y-2">
          {supportsProviderQuota && quotaSummaryGroups.length > 0 ? (
            <div className="space-y-2 pb-2 md:mb-4 md:rounded-xl md:border md:border-border md:bg-card md:p-4">
              <div className="grid gap-x-6 gap-y-3" style={{ gridTemplateColumns: `repeat(${quotaSummaryGroups.length}, minmax(0, 1fr))` }}>
                {quotaSummaryGroups.map((group) => (
                  <div key={group.name} className="space-y-1.5">
                    <div className="flex items-start justify-between gap-2 text-xs">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <p className="truncate font-medium text-foreground">{group.displayName}</p>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{group.accounts} account{group.accounts === 1 ? "" : "s"}</span>
                      </div>
                      <span className="font-mono text-xs text-muted-foreground">{quotaPercentRemaining(group)}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className={cnBar(quotaBarColor(group))} style={{ width: `${quotaPercentRemaining(group)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {isLoadingAccounts ? <UiSkeleton className="h-96 rounded-xl" /> : null}

          <div className="dashboard-card-grid">
            {accounts.map((account) => (
              <ProviderAccountCard
                key={account.id}
                id={account.id}
                account={{ ...account, stats: accountStatsById[account.id] }}
                showTier={providerMeta?.showTier}
                supportedModels={supportedModelsByAccountId[account.id] ?? supportedModels}
                disabledModels={disabledModelsByAccountId[account.id] ?? []}
                modelHealth={modelHealthByAccountId[account.id] ?? {}}
                errorHistory={errorHistoryByAccountId[account.id] ?? null}
                errorHistoryError={errorHistoryErrorByAccountId[account.id] ?? null}
                quotaInfo={quotaByAccountId[account.id] ?? null}
                quotaError={quotaErrorByAccountId[account.id] ?? null}
                quotaLoading={quotaLoadingByAccountId[account.id] ?? false}
                highlight={highlightedAccountIds.has(account.id)}
                readonly={isAuditMode}
                onRenamed={handleAccountRenamed}
                onActiveUpdated={handleAccountActiveUpdated}
                onDeleted={handleAccountDeleted}
                onErrorsResolved={handleAccountErrorsResolved}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function cnBar(color: string): string {
  return `h-full transition-all duration-300 ${color}`;
}
