import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { formatDistanceToNowStrict } from "date-fns";
import type { AccountQuotaInfo, ErrorHistoryResult, ProviderDetailData, ProviderAccountModelHealthItem, ProviderStats } from "../lib/dashboard-api-types";
import { compareModelIds } from "../lib/model-sort";
import { useDashboardApi } from "../hooks/useDashboardApi";
import { useDashboardDataInvalidation } from "../hooks/useDashboardDataInvalidation";
import { UsageSparkline } from "./UsageSparkline";
import { UsageStatMetric } from "./UsageStatMetric";
import { UiBadge } from "./ui/UiBadge";
import { UiButton } from "./ui/UiButton";
import { UiCard, UiCardContent, UiCardHeader, UiCardTitle } from "./ui/UiCard";
import { UiDialog } from "./ui/UiDialog";
import { UiIcon } from "./ui/UiIcon";
import { UiSkeleton } from "./ui/UiSkeleton";
import { UiSwitch } from "./ui/UiSwitch";
import { UiTooltip } from "./ui/UiTooltip";
import { cn } from "../lib/utils";

type Account = ProviderDetailData["accounts"][number];
type ErrorHistoryEntry = Extract<ErrorHistoryResult, { success: true }>["data"]["entries"][number];
type TemporaryOffUnit = "minutes" | "hours" | "days";

const QUOTA_PROVIDERS = new Set<string>(["antigravity", "codex", "kiro", "openrouter", "siliconflow", "command_code", "zenmux"]);
const TEMPORARY_OFF_UNITS: Array<{ value: TemporaryOffUnit; label: string; multiplier: number }> = [
  { value: "minutes", label: "Minutes", multiplier: 60 * 1000 },
  { value: "hours", label: "Hours", multiplier: 60 * 60 * 1000 },
  { value: "days", label: "Days", multiplier: 24 * 60 * 60 * 1000 },
];
const HTTP_STATUS_DESCRIPTIONS: Record<number, string> = {
  400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found", 408: "Request Timeout",
  429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};
const ERROR_PREVIEW_VISIBLE_COUNT = 9;

function formatRelativeTime(value: string | Date): string {
  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function compactNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return n.toLocaleString();
}

function formatDuration(duration: number | null): string {
  if (duration === null) return "-";
  if (duration >= 1000) return `${(duration / 1000).toFixed(2)}s`;
  return `${duration}ms`;
}

function isPaidTierValue(tier: string, provider?: string): boolean {
  const value = tier.trim().toLowerCase();
  if (provider === "antigravity") return value === "paid" || value === "standard-tier";
  if (provider === "kiro") return value === "pro" || value === "pro+" || value === "pro-plus" || value === "power";
  return ["paid", "standard-tier", "plus", "pro", "pro-plus", "pro+", "prolite", "power", "team", "go", "business", "enterprise", "edu", "education", "hc"].includes(value);
}

function formatTierBadgeLabel(tier: string, provider?: string): "Paid" | "Free" | "" {
  const normalized = tier.trim().toLowerCase();
  if (normalized === "") return "";
  return isPaidTierValue(normalized, provider) ? "Paid" : "Free";
}

function maskSensitiveText(value: string): string {
  if (value.length <= 2) return "*".repeat(Math.max(1, value.length));
  const visible = Math.min(2, Math.max(1, Math.floor(value.length / 4)));
  return value.slice(0, visible) + "*".repeat(value.length - visible);
}

function getAccountHeader(account: Account): { title: string; subtitle: string | null } {
  const title = account.name?.trim() || "";
  const parts = [account.email?.trim() || ""];
  const providerAccountId = (account as unknown as Record<string, unknown>)["accountId"];
  if (typeof providerAccountId === "string" && providerAccountId.trim()) parts.push(providerAccountId.trim());
  const subtitle = parts.filter(Boolean).join(" · ") || null;
  return { title, subtitle };
}

function expandDailyPoints(points: Array<{ date: string; count: number }>) {
  const valuesByDate = new Map(points.map((point) => [point.date, point.count]));
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const keys = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(todayUtc);
    date.setUTCDate(todayUtc.getUTCDate() - (29 - index));
    return date.toISOString().split("T")[0] ?? "";
  });
  return keys.map((date) => ({ date, count: valuesByDate.get(date) ?? 0 }));
}

function expandDurationPoints(points: Array<{ time: string; avgDuration: number }>) {
  const valuesByTime = new Map(points.map((point) => [point.time, point.avgDuration]));
  const now = new Date();
  const currentHourUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
  const keys = Array.from({ length: 24 }, (_, index) => {
    const date = new Date(currentHourUtc);
    date.setUTCHours(currentHourUtc.getUTCHours() - (23 - index));
    return date.toISOString();
  });
  return keys.map((time) => ({ time, avgDuration: valuesByTime.get(time) ?? null }));
}

function parseStoredErrorMessage(rawMessage: string): { error: string | null; provider: string | null; endpoint: string | null; model: string | null; parameters: string | null; messageObjects: string[] | null } {
  const result = { error: null as string | null, provider: null as string | null, endpoint: null as string | null, model: null as string | null, parameters: null as string | null, messageObjects: null as string[] | null };
  const lines = rawMessage.split("\n");
  for (const line of lines) {
    if (line.startsWith("Error: ")) result.error = line.slice(7);
    else if (line.startsWith("Provider: ")) result.provider = line.slice(10);
    else if (line.startsWith("Endpoint: ")) result.endpoint = line.slice(10);
    else if (line.startsWith("Model: ")) result.model = line.slice(7);
    else if (line.startsWith("Parameters: ")) result.parameters = line.slice(12);
    else if (line.startsWith("Messages (object keys only): ")) {
      try {
        const parsed = JSON.parse(line.slice(30)) as Array<Record<string, unknown>>;
        result.messageObjects = parsed.map((entry) => JSON.stringify(entry));
      } catch {
        result.messageObjects = [line.slice(30)];
      }
    }
  }
  return result;
}

function stripStatusFromErrorMessage(message: string, code: number | null): string {
  if (code === null) return message;
  const description = HTTP_STATUS_DESCRIPTIONS[code];
  if (!description) return message;
  const prefix = `${code} ${description}`;
  const marker = message.indexOf(prefix);
  if (marker < 0) return message;
  const after = message.slice(marker + prefix.length).replace(/^:?\s*/, "");
  return after || message;
}

function getErrorToneClass(code: number | null): string {
  if (code === null) return "text-foreground";
  if (code === 401 || code === 403) return "text-orange-400";
  if (code === 408 || code === 429 || code >= 500) return "text-red-500";
  return "text-foreground";
}

function AccountModelAccess({ accountId, provider, supportedModels, initialDisabledModels, modelHealth, readonly }: {
  accountId: string;
  provider: string;
  supportedModels: string[];
  initialDisabledModels: string[];
  modelHealth: Record<string, ProviderAccountModelHealthItem>;
  readonly: boolean;
}) {
  const dashboardApi = useDashboardApi();
  const dashboardInvalidation = useDashboardDataInvalidation();
  const [disabledModels, setDisabledModels] = useState<Set<string>>(new Set(initialDisabledModels));
  const [expanded, setExpanded] = useState(false);
  const visibleCount = 5;

  const enabledCount = supportedModels.length - disabledModels.size;
  const hasMore = supportedModels.length > visibleCount;
  const sortedModels = useMemo(() => [...supportedModels].sort((a, b) => {
    const statusA = modelHealth[a]?.status;
    const statusB = modelHealth[b]?.status;
    if (statusA === "degraded" && statusB !== "degraded") return -1;
    if (statusB === "degraded" && statusA !== "degraded") return 1;
    return compareModelIds(a, b);
  }), [supportedModels, modelHealth]);
  const visibleModels = expanded ? sortedModels : sortedModels.slice(0, visibleCount);
  const hiddenCount = supportedModels.length - visibleModels.length;

  const toggleModel = async (model: string) => {
    if (readonly) return;
    const enabled = disabledModels.has(model);
    const previous = new Set(disabledModels);
    const next = new Set(disabledModels);
    if (enabled) next.delete(model);
    else next.add(model);
    setDisabledModels(next);
    try {
      const result = await dashboardApi.accounts.setAccountModelEnabled({ accountId, modelId: model, enabled: !enabled });
      if (!result.success) throw new Error(result.error);
      dashboardInvalidation.refreshDashboardData([dashboardInvalidation.keys.playgroundOptions, dashboardInvalidation.keys.apiKeys]);
    } catch {
      setDisabledModels(previous);
    }
  };

  if (!supportedModels.length) return null;

  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Model Access</span>
        <span className="text-xs text-muted-foreground">{enabledCount}/{supportedModels.length}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {visibleModels.map((model) => {
          const disabled = disabledModels.has(model);
          const status = modelHealth[model]?.status;
          return (
            <button
              key={model}
              type="button"
              disabled={readonly}
              title={disabled ? "Enable" : "Disable"}
              className={cn(
                "cursor-pointer rounded-md px-2 py-1 font-mono text-[10px] transition-colors disabled:cursor-default disabled:opacity-60",
                disabled ? "border border-border/60 bg-transparent text-muted-foreground/60 line-through" : status === "degraded" ? "border border-yellow-500/45 bg-transparent text-yellow-700" : "border border-border bg-transparent text-foreground hover:bg-muted/30",
              )}
              onClick={() => void toggleModel(model)}
            >
              {model}
            </button>
          );
        })}
      </div>
      {hasMore ? (
        <button type="button" disabled={readonly} className="cursor-pointer text-[11px] text-muted-foreground transition-colors hover:text-foreground" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : `Show ${hiddenCount} more`}
        </button>
      ) : null}
    </div>
  );
}

export interface ProviderAccountCardProps {
  id: string;
  account: Account & { stats?: ProviderStats };
  showTier?: boolean;
  supportedModels: string[];
  disabledModels: string[];
  modelHealth: Record<string, ProviderAccountModelHealthItem>;
  errorHistory: ErrorHistoryEntry[] | null;
  errorHistoryError: string | null;
  quotaInfo: AccountQuotaInfo | null;
  quotaError: string | null;
  quotaLoading: boolean;
  highlight?: boolean;
  readonly?: boolean;
  onRenamed?: () => void;
  onActiveUpdated?: () => void;
  onDeleted?: () => void;
  onErrorsResolved?: () => void;
}

export function ProviderAccountCard({ id, account, showTier, supportedModels, disabledModels, modelHealth, errorHistory, errorHistoryError, quotaInfo, quotaError, quotaLoading, highlight = false, readonly, onRenamed, onActiveUpdated, onDeleted, onErrorsResolved }: ProviderAccountCardProps) {
  const dashboardApi = useDashboardApi();
  const [isSubtitleVisible, setIsSubtitleVisible] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [errorDialogOpen, setErrorDialogOpen] = useState(false);
  const [temporaryOffDialogOpen, setTemporaryOffDialogOpen] = useState(false);
  const [editName, setEditName] = useState(account.name);
  const [temporaryOffAmount, setTemporaryOffAmount] = useState(30);
  const [temporaryOffUnit, setTemporaryOffUnit] = useState<TemporaryOffUnit>("minutes");
  const [savingName, setSavingName] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const [isTemporaryDisabling, setIsTemporaryDisabling] = useState(false);
  const [resolvingErrors, setResolvingErrors] = useState(false);
  const [temporaryOffError, setTemporaryOffError] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [activeErrorIndex, setActiveErrorIndex] = useState(0);
  const [copiedErrorPreview, setCopiedErrorPreview] = useState(false);

  const { title, subtitle } = getAccountHeader(account);
  const accountTitle = title || "Provider account";
  const normalizedTier = (account.tier ?? "").trim().toLowerCase();
  const tierBadgeLabel = formatTierBadgeLabel(normalizedTier, account.provider);
  const showTierBadge = Boolean(showTier && tierBadgeLabel !== "");
  const supportsQuotaMonitor = QUOTA_PROVIDERS.has(account.provider);

  const stats = account.stats ?? {
    totalRequests: 0, totalTokens: 0, successRate: null, dailyRequests: [], avgDurationLastDay: null, durationLast24Hours: [],
  };
  const usageStats = [
    { key: "totalRequests", label: "Requests", value: stats.totalRequests.toLocaleString() },
    { key: "totalTokens", label: "Token", value: compactNumber(stats.totalTokens) },
    { key: "successRate", label: "Success", value: stats.successRate === null ? "-" : `${stats.successRate}%` },
    { key: "avgDuration", label: "Latency", value: formatDuration(stats.avgDurationLastDay) },
  ];

  const dailyValues = expandDailyPoints(stats.dailyRequests).map((point) => point.count);
  const durationPoints = expandDurationPoints(stats.durationLast24Hours);
  const durationValues = durationPoints.map((point) => point.avgDuration ?? 0);
  const tickCount = Math.min(5, durationPoints.length);
  const indexes = Array.from(new Set(Array.from({ length: tickCount }, (_, index) => Math.round((index / (tickCount - 1 || 1)) * (durationPoints.length - 1)))));
  const durationLabelPoints = indexes.map((index) => durationPoints[index]).filter(Boolean) as Array<{ time: string; avgDuration: number | null }>;
  const usageChartColor = account.isActive ? "var(--chart-1)" : "var(--muted-foreground)";
  const usageChartColorAlt = account.isActive ? "var(--chart-2)" : "var(--muted-foreground)";

  const activeDisabledUntil = account.disabledUntil && !account.isActive ? new Date(account.disabledUntil) : null;
  const accountStatusLabel = account.isActive ? (activeDisabledUntil ? `Off until ${activeDisabledUntil.toLocaleString()}` : "On") : activeDisabledUntil ? `Off until ${activeDisabledUntil.toLocaleString()}` : "Off";
  const latestHistoryEntry = errorHistory?.[0] ?? null;
  const allErrorPreviewEntries = (errorHistory ?? []).slice(0, 20).map((entry) => entry);
  const activeErrorEntry = allErrorPreviewEntries[activeErrorIndex] ?? allErrorPreviewEntries[0] ?? null;
  const errorPreviewToneClass = activeErrorEntry ? getErrorToneClass(activeErrorEntry.errorCode) : "text-foreground";
  const displayErrorMessage = activeErrorEntry ? stripStatusFromErrorMessage(activeErrorEntry.errorMessage, activeErrorEntry.errorCode) : "";
  const errorDetails = activeErrorEntry ? parseStoredErrorMessage(activeErrorEntry.errorMessage) : null;
  const hasPreviousErrorPreview = activeErrorIndex < allErrorPreviewEntries.length - 1;
  const hasNewerErrorPreview = activeErrorIndex > 0;

  const renameAccount = async () => {
    setSavingName(true);
    setErrorMessage("");
    try {
      const result = await dashboardApi.accounts.update({ id: account.id, name: editName.trim() });
      if (!result.success) throw new Error(result.error);
      setEditDialogOpen(false);
      onRenamed?.();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to rename account");
    } finally {
      setSavingName(false);
    }
  };

  const toggleActive = async () => {
    if (readonly) return;
    setIsToggling(true);
    setErrorMessage("");
    try {
      const result = await dashboardApi.accounts.update({ id: account.id, isActive: !account.isActive });
      if (!result.success) throw new Error(result.error);
      onActiveUpdated?.();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to toggle account");
    } finally {
      setIsToggling(false);
    }
  };

  const disableTemporarily = async () => {
    if (readonly) return;
    const unit = TEMPORARY_OFF_UNITS.find((u) => u.value === temporaryOffUnit)!;
    const disabledUntil = new Date(Date.now() + temporaryOffAmount * unit.multiplier);
    setIsTemporaryDisabling(true);
    setTemporaryOffError("");
    try {
      const result = await dashboardApi.accounts.update({ id: account.id, disabledUntil });
      if (!result.success) throw new Error(result.error);
      setTemporaryOffDialogOpen(false);
      onActiveUpdated?.();
    } catch (error) {
      setTemporaryOffError(error instanceof Error ? error.message : "Failed to disable account");
    } finally {
      setIsTemporaryDisabling(false);
    }
  };

  const deleteAccount = async () => {
    if (readonly) return;
    setDeleting(true);
    setErrorMessage("");
    try {
      const result = await dashboardApi.accounts.delete({ id: account.id });
      if (!result.success) throw new Error(result.error);
      setDeleteDialogOpen(false);
      onDeleted?.();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to delete account");
    } finally {
      setDeleting(false);
    }
  };

  const resolveErrors = async () => {
    if (readonly) return;
    setResolvingErrors(true);
    setErrorMessage("");
    try {
      const result = await dashboardApi.accounts.resolveErrors({ accountId: account.id });
      if (!result.success) throw new Error(result.error);
      setErrorDialogOpen(false);
      onErrorsResolved?.();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to resolve errors");
    } finally {
      setResolvingErrors(false);
    }
  };

  const copyErrorPreview = async () => {
    if (!activeErrorEntry) return;
    await navigator.clipboard.writeText(activeErrorEntry.errorMessage);
    setCopiedErrorPreview(true);
    window.setTimeout(() => setCopiedErrorPreview(false), 2000);
  };

  const quotaPercentRemaining = (group: { remainingFraction: number }) => Math.round(group.remainingFraction * 100);
  const quotaBarColor = (group: { remainingFraction: number }) => {
    const percent = quotaPercentRemaining(group);
    if (percent > 50) return "bg-emerald-500";
    if (percent > 20) return "bg-yellow-500";
    return "bg-destructive";
  };
  const quotaTextColor = (group: { remainingFraction: number }) => {
    const percent = quotaPercentRemaining(group);
    if (percent > 50) return "text-emerald-500";
    if (percent > 20) return "text-yellow-500";
    return "text-destructive";
  };

  const temporaryOffPreview = (() => {
    const unit = TEMPORARY_OFF_UNITS.find((u) => u.value === temporaryOffUnit)!;
    return new Date(Date.now() + temporaryOffAmount * unit.multiplier).toLocaleString();
  })();

  return (
    <div className="h-full">
      <UiCard
        className={cn(
          "flex h-full flex-col bg-transparent transition-[border-color,box-shadow] duration-[1800ms] ease-out",
          !account.isActive && "opacity-65",
          highlight ? "border-primary shadow-[0_0_0_3px_var(--primary)]" : "border-border shadow-none",
        )}
      >
        <UiCardHeader className="pb-1">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <UiCardTitle className="min-w-0 truncate text-lg">{accountTitle}</UiCardTitle>
            <div className="flex shrink-0 items-center justify-end gap-1 whitespace-nowrap">
              {showTierBadge ? (
                <UiBadge variant="outline" className={isPaidTierValue(normalizedTier, account.provider) ? "border-green-500 text-green-600" : ""}>
                  {tierBadgeLabel}
                </UiBadge>
              ) : null}
              {account.status === "failed" ? (
                <UiBadge variant="outline" className="gap-1 border-destructive/60 text-destructive">
                  <UiIcon name="i-lucide-alert-circle" className="size-3" />
                  {account.unhealthyCount}
                </UiBadge>
              ) : account.unhealthyCount > 0 ? (
                <UiBadge variant="outline" className="gap-1 border-yellow-500 text-yellow-600">
                  <UiIcon name="i-lucide-triangle-alert" className="size-3" />
                  {account.unhealthyCount}
                </UiBadge>
              ) : null}
            </div>
          </div>
          {subtitle ? (
            <div className={cn("flex min-w-0 items-center gap-1", isSubtitleVisible ? "" : "w-full overflow-hidden")}>
              <UiTooltip text={isSubtitleVisible ? "Hide" : "Show"}>
                <button
                  type="button"
                  className="h-7 w-7 shrink-0 cursor-pointer rounded-md text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground"
                  aria-label={isSubtitleVisible ? `Hide account email for ${accountTitle}` : `Show account email for ${accountTitle}`}
                  onClick={() => setIsSubtitleVisible(!isSubtitleVisible)}
                >
                  <UiIcon name={isSubtitleVisible ? "i-lucide-eye-off" : "i-lucide-eye"} className="size-3.5" />
                </button>
              </UiTooltip>
              <p className={cn("min-w-0 font-mono text-sm text-muted-foreground", isSubtitleVisible ? "break-all whitespace-normal" : "truncate whitespace-nowrap")}>
                {isSubtitleVisible ? subtitle : maskSensitiveText(subtitle)}
              </p>
            </div>
          ) : null}
        </UiCardHeader>

        <UiCardContent className="flex flex-1 flex-col pt-0">
          <div className="flex-1 space-y-2 text-sm">
            <div className="mb-3">
              <div className="mb-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)] gap-1.5">
                {usageStats.map((stat) => (
                  <UsageStatMetric key={stat.key} label={stat.label} value={stat.value} />
                ))}
              </div>
              <div className="mb-2">
                <UsageSparkline values={durationValues} color={usageChartColorAlt} ariaLabel={`Average duration trend for ${accountTitle} over last 24 hours`} className="h-6" height={24} />
                <div className="mt-0.5 grid grid-cols-5 text-[9px]">
                  {durationLabelPoints.map((point) => (
                    <span key={point.time} className="truncate text-center text-muted-foreground">{point.time.slice(11, 16)}</span>
                  ))}
                </div>
              </div>
              <UsageSparkline values={dailyValues} color={usageChartColor} ariaLabel={`Requests trend for ${accountTitle}`} />
            </div>

            <div className="flex justify-between"><span className="text-muted-foreground">Last used</span><span className="font-medium">{account.lastUsedAt ? formatRelativeTime(account.lastUsedAt) : "-"}</span></div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last error</span>
              <span className={cn("font-medium", account.lastErrorAt ? (account.lastErrorCode !== null && (account.lastErrorCode === 408 || account.lastErrorCode === 429 || account.lastErrorCode >= 500) ? "text-red-500" : "text-muted-foreground") : "text-muted-foreground")}>
                {account.lastErrorAt ? formatRelativeTime(account.lastErrorAt) : "-"}
              </span>
            </div>

            <div className={cn("min-h-14", activeErrorEntry ? "" : "hidden sm:block")}>
              <div className="space-y-1.5 pt-2">
                <div className="h-32 pb-1">
                  {activeErrorEntry ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      className="flex h-full w-full cursor-pointer touch-pan-y flex-col rounded-sm border border-border/60 bg-muted/30 px-2 pb-2 pt-2 text-left select-none hover:bg-muted/40"
                      onClick={() => setErrorDialogOpen(true)}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <UiBadge variant="outline" className="h-5 shrink-0 px-1.5 py-0 text-[10px] font-medium">{activeErrorEntry.errorCode ?? "—"}</UiBadge>
                          <span className="truncate text-xs text-muted-foreground">{HTTP_STATUS_DESCRIPTIONS[activeErrorEntry.errorCode ?? -1] ?? "No status code"}</span>
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
                          className="shrink-0 cursor-pointer rounded p-0.5"
                          aria-label="Copy error message"
                          onClick={(event) => { event.stopPropagation(); void copyErrorPreview(); }}
                        >
                          <UiIcon name={copiedErrorPreview ? "i-lucide-check" : "i-lucide-copy"} className="size-3 text-muted-foreground" />
                        </span>
                      </div>
                      <span className={cn("mt-1 flex min-h-0 flex-1 items-center break-all text-xs line-clamp-4", errorPreviewToneClass)}>
                        {displayErrorMessage}
                      </span>
                      <span className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground/80">
                        <span>{formatRelativeTime(activeErrorEntry.createdAt)}</span>
                        <span className="min-w-0 truncate text-right font-mono">{activeErrorEntry.model}</span>
                      </span>
                    </button>
                  ) : (
                    <div className="flex h-full w-full items-center justify-center rounded-sm border border-border/60 bg-muted/20 px-2 text-center text-xs text-muted-foreground">No data</div>
                  )}
                </div>

                {errorHistoryError ? <p className="truncate text-[10px] text-red-500">{errorHistoryError}</p> : allErrorPreviewEntries.length > 0 ? (
                  <div className="flex items-center justify-between gap-2">
                    <UiTooltip text="Newer">
                      <UiButton type="button" variant="outline" size="icon-sm" className="h-6 w-6" disabled={!hasNewerErrorPreview} aria-label="Show newer error" onClick={() => setActiveErrorIndex((i) => Math.max(0, i - 1))}>
                        <UiIcon name="i-lucide-chevron-left" className="size-3.5" />
                      </UiButton>
                    </UiTooltip>
                    <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
                      {allErrorPreviewEntries.slice(0, ERROR_PREVIEW_VISIBLE_COUNT).map((entry, index) => (
                        <span
                          key={entry.id}
                          className={cn("h-1.5 rounded-full", index === activeErrorIndex ? "w-3 bg-foreground" : "w-1.5 bg-border")}
                        />
                      ))}
                    </div>
                    <UiTooltip text="Older">
                      <UiButton type="button" variant="outline" size="icon-sm" className="h-6 w-6" disabled={!hasPreviousErrorPreview} aria-label="Show previous error" onClick={() => setActiveErrorIndex((i) => Math.min(allErrorPreviewEntries.length - 1, i + 1))}>
                        <UiIcon name="i-lucide-chevron-right" className="size-3.5" />
                      </UiButton>
                    </UiTooltip>
                  </div>
                ) : null}
              </div>
            </div>

            {supportsQuotaMonitor ? (
              <div className="mt-3 space-y-2 border-t pt-3">
                <div><span className="text-xs font-medium text-muted-foreground">Quota</span></div>
                {quotaLoading && !quotaInfo && !quotaError ? (
                  <div className="space-y-2" aria-hidden="true">
                    {[0, 1, 2].map((index) => (
                      <div key={index} className="space-y-1">
                        <UiSkeleton className="h-3 w-24" />
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <UiSkeleton className="h-full w-1/3 rounded-full" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                {quotaError ? <p className="text-xs text-red-500">{quotaError}</p> : null}
                {!quotaLoading && quotaInfo?.status === "success" && quotaInfo.groups.length > 0 ? (
                  <div className="space-y-2">
                    {quotaInfo.groups.map((group) => (
                      <div key={group.name} className="space-y-1">
                        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs">
                          <span className="min-w-0 truncate text-muted-foreground">{group.displayName}</span>
                          <span className="flex min-w-0 max-w-28 shrink-0 items-center justify-end gap-1.5 overflow-hidden">
                            {group.resetInHuman ? <span className="block max-w-20 truncate text-[10px] text-muted-foreground">{group.resetInHuman}</span> : null}
                            <span className={cn("shrink-0 font-mono", quotaTextColor(group))}>{quotaPercentRemaining(group)}%</span>
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className={cn("h-full transition-all duration-300", quotaBarColor(group))} style={{ width: `${quotaPercentRemaining(group)}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : !quotaLoading && !quotaError && quotaInfo ? (
                  <p className="text-xs text-red-500">{quotaInfo.error ?? "Failed to fetch quota data."}</p>
                ) : null}
              </div>
            ) : null}

            <AccountModelAccess
              accountId={account.id}
              provider={account.provider}
              supportedModels={supportedModels}
              initialDisabledModels={disabledModels}
              modelHealth={modelHealth}
              readonly={Boolean(readonly)}
            />
          </div>

          <div className="mt-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <UiTooltip text={readonly ? "" : "Edit"}>
                <UiButton variant="outline" size="sm" disabled={readonly} aria-label={`Edit ${accountTitle}`} onClick={() => setEditDialogOpen(true)}>
                  <UiIcon name="i-lucide-pencil" className="size-3" />
                </UiButton>
              </UiTooltip>
              <UiTooltip text={readonly ? "" : "Delete"}>
                <UiButton variant="outline" size="sm" disabled={readonly} aria-label={`Delete ${accountTitle}`} onClick={() => setDeleteDialogOpen(true)}>
                  <UiIcon name="i-lucide-trash-2" className="size-3 text-destructive" />
                </UiButton>
              </UiTooltip>
              <UiTooltip text="Playground">
                <Link to={`/dashboard/playground?accountId=${account.id}`}>
                  <UiButton variant="outline" size="sm">
                    <UiIcon name="i-lucide-flask-conical" className="size-3" />
                  </UiButton>
                </Link>
              </UiTooltip>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <UiTooltip text={accountStatusLabel}>
                <span className="max-w-32 truncate text-[11px] text-muted-foreground">{accountStatusLabel}</span>
              </UiTooltip>
              <UiSwitch checked={account.isActive} disabled={readonly || isToggling} title={account.isActive ? "Disable" : "Enable"} onCheckedChange={() => void toggleActive()} />
            </div>
          </div>
          {errorMessage ? <p className="text-right text-xs text-destructive">{errorMessage}</p> : null}
        </UiCardContent>
      </UiCard>

      <UiDialog open={temporaryOffDialogOpen} onOpenChange={setTemporaryOffDialogOpen} ui={{ content: "sm:max-w-md" }}>
        <div className="space-y-1.5 pr-6">
          <h2 className="text-lg font-semibold">Disable Temporarily</h2>
          <p className="text-sm text-muted-foreground">Choose how long "{account.name}" should stay off.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <label className="grid gap-1 text-sm font-medium">
            Duration
            <input value={temporaryOffAmount} onChange={(event) => setTemporaryOffAmount(Number(event.target.value))} type="number" min={1} step={1} className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" onKeyDown={(event) => { if (event.key === "Enter") void disableTemporarily(); }} />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Unit
            <select value={temporaryOffUnit} onChange={(event) => setTemporaryOffUnit(event.target.value as TemporaryOffUnit)} className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
              {TEMPORARY_OFF_UNITS.map((unit) => (
                <option key={unit.value} value={unit.value}>{unit.label}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">This account will turn back on {temporaryOffPreview}.</p>
        {temporaryOffError ? <p className="text-sm text-red-500">{temporaryOffError}</p> : null}
        <div className="flex justify-end gap-2">
          <UiButton variant="outline" disabled={isTemporaryDisabling} onClick={() => setTemporaryOffDialogOpen(false)}>Cancel</UiButton>
          <UiButton disabled={isTemporaryDisabling} onClick={() => void disableTemporarily()}>{isTemporaryDisabling ? "Disabling..." : "Disable"}</UiButton>
        </div>
      </UiDialog>

      <UiDialog open={editDialogOpen} onOpenChange={setEditDialogOpen} ui={{ content: "sm:max-w-md" }}>
        <label className="grid gap-1 text-sm font-medium">
          <span>Name <span className="text-destructive">*</span></span>
          <input value={editName} onChange={(event) => setEditName(event.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" onKeyDown={(event) => { if (event.key === "Enter") void renameAccount(); }} />
        </label>
        <div className="flex justify-end gap-2">
          <UiButton variant="outline" onClick={() => setEditDialogOpen(false)}>Cancel</UiButton>
          <UiButton disabled={savingName} onClick={() => void renameAccount()}>{savingName ? "Saving..." : "Save"}</UiButton>
        </div>
      </UiDialog>

      <UiDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen} ui={{ content: "sm:max-w-md" }}>
        <div className="space-y-1.5 pr-6">
          <h2 className="text-lg font-semibold">Delete Account</h2>
          <p className="text-sm text-muted-foreground">Delete <strong className="font-semibold text-foreground">{account.name}</strong> &mdash; this cannot be undone.</p>
        </div>
        <div className="flex justify-end gap-2">
          <UiButton variant="outline" onClick={() => setDeleteDialogOpen(false)}>Cancel</UiButton>
          <UiButton variant="destructive" disabled={deleting} onClick={() => void deleteAccount()}>{deleting ? "Deleting..." : "Delete"}</UiButton>
        </div>
      </UiDialog>

      <UiDialog open={errorDialogOpen} onOpenChange={setErrorDialogOpen} ui={{ content: "sm:max-w-xl" }}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            <UiTooltip text="Resolve">
              <UiButton type="button" variant="outline" size="icon-sm" aria-label="Resolve errors" disabled={resolvingErrors} onClick={() => void resolveErrors()}>
                <UiIcon name="i-lucide-check-circle" className="size-4 text-green-600" />
              </UiButton>
            </UiTooltip>
          </div>
          <UiTooltip text="Close">
            <UiButton type="button" variant="ghost" size="icon-sm" aria-label="Close error details" className="shrink-0" onClick={() => setErrorDialogOpen(false)}>
              <UiIcon name="i-lucide-x" className="size-4" />
            </UiButton>
          </UiTooltip>
        </div>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto rounded-md border bg-muted/20 p-3">
          {errorDetails && (errorDetails.provider || errorDetails.endpoint || errorDetails.model) ? (
            <div className="rounded-md border bg-background/70 p-2">
              {errorDetails.provider ? <p className="text-xs"><span className="text-muted-foreground">Provider:</span> <span className="font-mono">{errorDetails.provider}</span></p> : null}
              {errorDetails.endpoint ? <p className="text-xs"><span className="text-muted-foreground">Endpoint:</span> <span className="font-mono">{errorDetails.endpoint}</span></p> : null}
              {errorDetails.model ? <p className="text-xs"><span className="text-muted-foreground">Model:</span> <span className="font-mono">{errorDetails.model}</span></p> : null}
            </div>
          ) : null}
          {errorDetails?.error ? (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Error</p>
              <p className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{errorDetails.error}</p>
            </div>
          ) : null}
          {errorDetails?.parameters ? (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Body Parameters</p>
              <p className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{errorDetails.parameters}</p>
            </div>
          ) : null}
          {!errorDetails?.error && !errorDetails?.parameters ? (
            <p className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{displayErrorMessage}</p>
          ) : null}
        </div>
      </UiDialog>
    </div>
  );
}
