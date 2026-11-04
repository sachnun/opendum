import { For, Show, createEffect, createMemo, createSignal, on, type JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { QUOTA_PROVIDER_KEYS } from "@opendum/providers/provider-accounts";
import type { AccountQuotaInfo, AccountUpdateData, ErrorHistoryResult, ProviderDetailData, QuotaGroupDisplay } from "~/lib/api-types";
import {
  addParam,
  addParams,
  isRecoverable,
  messageModel,
  normalizeEndpoint,
  parseMessage,
  parseParams,
  stripStatus,
} from "~/lib/account-errors";
import {
  accountHeader,
  compactNumber,
  dailyPoints,
  dateTime,
  durationPoints,
  errorPreview,
  errorStatus,
  errorTime,
  formatDuration,
  hourLabel,
  maskText,
  paidTier,
  prevDay,
  relativeTime,
  signedDuration,
  signedInteger,
  signedPercent,
  statValues,
  tierLabel,
  timeOf,
  type Account,
  type DurationPoint,
  type ErrorPreviewEntry,
  type StatDeltaTone,
  type StatMetric,
} from "~/lib/account-format";
import { percentRemaining, resetTitle } from "~/lib/quota-display";
import { Routes } from "~/lib/routes";
import { createAccountActions, TEMPORARY_OFF_UNITS } from "~/lib/account-actions";
import { auditState, auditUser, isAuditMode } from "~/lib/audit";
import { api } from "~/api";
import { settle } from "~/lib/settle";
import { AccountModelAccess } from "~/components/account/AccountModelAccess";
import { UsageSparkline } from "~/components/usage/UsageSparkline";
import { UsageStatMetric } from "~/components/usage/UsageStatMetric";
import { UiBadge } from "~/components/ui/UiBadge";
import { UiButton } from "~/components/ui/UiButton";
import { UiCard, UiCardContent, UiCardHeader, UiCardTitle } from "~/components/ui/UiCard";
import { UiDialog } from "~/components/ui/UiDialog";
import { UiIcon } from "~/components/ui/UiIcon";
import { UiSwitch } from "~/components/ui/UiSwitch";
import { UiTooltip } from "~/components/ui/UiTooltip";

type ErrorHistoryEntry = Extract<ErrorHistoryResult, { success: true }>["data"]["entries"][number];
type StatHit = { text: string; tone: StatDeltaTone; version: number };

const QUOTA_PROVIDERS = new Set<string>(QUOTA_PROVIDER_KEYS);
const SWIPE_THRESHOLD = 45;
const PREVIEW_COUNT = 9;
const PREVIEW_CENTER = 4;

export interface ProviderAccountCardProps {
  account: Account;
  showTier?: boolean;
  supportedModels?: string[];
  disabledModels?: string[];
  modelHealth?: ProviderDetailData["modelHealthByAccountId"][string];
  errorHistory?: ErrorHistoryEntry[] | null;
  errorHistoryError?: string | null;
  quotaInfo?: AccountQuotaInfo | null;
  quotaError?: string | null;
  highlight?: boolean;
  animateDeltas?: boolean;
  readonly?: boolean;
  visible?: boolean;
  pointsBalance?: number;
  onRenamed: (account: AccountUpdateData) => void;
  onActiveUpdated: (account: AccountUpdateData) => void;
  onTemporarilyDisabled: (account: AccountUpdateData) => void;
  onDeleted: (accountId: string) => void;
  onErrorsResolved: (accountId: string) => void;
}

export function ProviderAccountCard(props: ProviderAccountCardProps): JSX.Element {
  const navigate = useNavigate();
  const [editDialogOpen, setEditDialogOpen] = createSignal(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = createSignal(false);
  const [errorDialogOpen, setErrorDialogOpen] = createSignal(false);
  const [isSubtitleVisible, setIsSubtitleVisible] = createSignal(true);
  const [resolvingErrors, setResolvingErrors] = createSignal(false);
  const [copiedErrorDetails, setCopiedErrorDetails] = createSignal(false);
  const [copiedAllErrors, setCopiedAllErrors] = createSignal(false);
  const [copiedErrorPreview, setCopiedErrorPreview] = createSignal(false);
  const [copiedSession, setCopiedSession] = createSignal(false);
  const [sessionLoading, setSessionLoading] = createSignal(false);
  const [statHitEffects, setStatHitEffects] = createSignal<Record<string, StatHit>>({});
  const [previousStatValues, setPreviousStatValues] = createSignal<Record<string, number> | null>(null);
  const [prevAnimKey, setPrevAnimKey] = createSignal<string | null>(null);
  const [pendingBaselineKey, setPendingBaselineKey] = createSignal<string | null>(null);
  const [activeErrorIndex, setActiveErrorIndex] = createSignal(0);
  let dragStartX: number | null = null;
  let suppressClick = false;

  const actions = createAccountActions(
    () => props.account,
    () => props.readonly ?? false,
    {
      onActiveUpdated: (data) => props.onActiveUpdated(data),
      onTemporarilyDisabled: (data) => props.onTemporarilyDisabled(data),
      onRenamed: (data) => {
        setEditDialogOpen(false);
        props.onRenamed(data);
      },
      onDeleted: (id) => {
        setDeleteDialogOpen(false);
        props.onDeleted(id);
      },
    }
  );

  const isMaintainer = () => import.meta.env.DEV || (auditState.me()?.isMaintainer ?? false);

  const header = createMemo(() => accountHeader(props.account));
  const accountTitle = createMemo(() => header().title || "Provider account");
  const historyError = () => props.errorHistoryError ?? null;
  const historyEntries = () => props.errorHistory ?? null;
  const subtitle = () => header().subtitle;
  const subtitleDisplay = () => {
    const value = subtitle();
    if (!value) return null;
    return isSubtitleVisible() ? value : maskText(value);
  };

  const dailyValues = createMemo(() => dailyPoints(props.account.stats.dailyRequests).map((point) => point.count));
  const duration = createMemo(() => durationPoints(props.account.stats.durationLast24Hours));
  const durationValues = createMemo(() => duration().map((point) => point.avgDuration ?? 0));
  const durationLabelPoints = createMemo(() => {
    const points = duration();
    const tickCount = Math.min(5, points.length);
    const indexes = Array.from(
      new Set(Array.from({ length: tickCount }, (_, index) => Math.round((index / (tickCount - 1 || 1)) * (points.length - 1))))
    );
    return indexes.map((index) => points[index]).filter(Boolean) as DurationPoint[];
  });

  const statMetrics = createMemo<StatMetric[]>(() => [
    {
      key: "totalRequests",
      label: "Requests",
      value: props.account.stats.totalRequests.toLocaleString(),
      numericValue: props.account.stats.totalRequests,
      formatDelta: signedInteger,
    },
    {
      key: "totalTokens",
      label: "Token",
      value: compactNumber(props.account.stats.totalTokens),
      numericValue: props.account.stats.totalTokens,
      formatDelta: signedInteger,
    },
    {
      key: "successRate",
      label: "Success",
      value: props.account.stats.successRate === null ? "-" : `${props.account.stats.successRate}%`,
      numericValue: props.account.stats.successRate ?? Number.NaN,
      formatDelta: signedPercent,
    },
    {
      key: "avgDuration",
      label: "Latency",
      value: formatDuration(props.account.stats.avgDurationLastDay),
      numericValue: props.account.stats.avgDurationLastDay ?? Number.NaN,
      formatDelta: signedDuration,
      getTone: (delta) => (delta > 0 ? "negative" : "positive"),
    },
  ]);

  const animKey = createMemo(() => {
    const userKey = isAuditMode() ? `audit:${auditUser()?.id ?? ""}` : "self";
    return `${props.account.id}:${userKey}:${auditState.auditRefreshVersion()}`;
  });

  const usageStats = createMemo(() =>
    statMetrics().map((stat) => ({ ...stat, hit: props.animateDeltas === false ? undefined : statHitEffects()[stat.key] }))
  );

  const normalizedTier = () => props.account.tier?.trim().toLowerCase() || "";
  const tierBadgeLabel = () => tierLabel(normalizedTier(), props.account.provider);
  const showTierBadge = () => Boolean(props.showTier) && tierBadgeLabel() !== "";
  const supportsQuotaMonitor = () => QUOTA_PROVIDERS.has(props.account.provider);
  const usageChartColor = () => (props.account.isActive ? "var(--chart-1)" : "var(--muted-foreground)");
  const chartColorAlt = () => (props.account.isActive ? "var(--chart-2)" : "var(--muted-foreground)");

  const activeDisabledUntil = createMemo(() => {
    if (!props.account.disabledUntil) return null;
    const disabledUntil = new Date(props.account.disabledUntil);
    if (Number.isNaN(disabledUntil.getTime()) || disabledUntil <= new Date()) return null;
    return disabledUntil;
  });

  const accountStatusLabel = () => {
    const until = activeDisabledUntil();
    if (until) return `Cooldown ${relativeTime(until).replace(/^in\s+/, "")}`;
    return props.account.isActive ? "On" : "Off";
  };
  const accountStatusTitle = () => {
    const until = activeDisabledUntil();
    return until ? `Temporarily disabled until ${until.toLocaleString()}` : undefined;
  };
  const temporaryOffPreview = () => {
    const until = actions.offUntil();
    if (!until) return "Select a valid future duration.";
    return `${relativeTime(until)} (${dateTime(until)})`;
  };

  function recoveredAt(): number {
    return Math.max(
      timeOf(props.account.lastSuccessAt) ?? 0,
      timeOf(props.account.lastRecoveredAt) ?? 0,
      timeOf(props.account.lastUsedAt) ?? 0
    );
  }

  function recoveredTone(entry: ErrorPreviewEntry | null | undefined, recovered: boolean): string {
    if (!recovered) return "text-red-500";
    if (isRecoverable(entry?.errorCode)) return "text-foreground";
    return "text-amber-400";
  }

  function errorTone(entry: ErrorPreviewEntry | null | undefined): string {
    const errorMs = timeOf(entry?.createdAt);
    if (!errorMs) return "text-muted-foreground";

    const recoveredMs = recoveredAt();
    const recovered = recoveredMs > errorMs;

    const model = entry?.model?.trim() || (entry?.errorMessage ? messageModel(entry.errorMessage, entry.errorCode) : null);
    if (model) {
      const health = props.modelHealth?.[model];
      const modelRecoveredMs = timeOf(health?.lastSuccessAt);
      const modelRecovered = Boolean(modelRecoveredMs && modelRecoveredMs > errorMs);
      return recoveredTone(entry, modelRecovered || recovered);
    }

    return recoveredTone(entry, recovered);
  }

  const allPreviewEntries = createMemo<ErrorPreviewEntry[]>(() =>
    (historyEntries() ?? [])
      .map((entry) => ({
        id: entry.id,
        model: entry.model ?? messageModel(entry.errorMessage, entry.errorCode),
        errorCode: entry.errorCode,
        errorMessage: entry.errorMessage,
        createdAt: entry.createdAt,
      }))
      .sort((a, b) => (timeOf(b.createdAt) ?? 0) - (timeOf(a.createdAt) ?? 0))
  );

  const previewStart = createMemo(() => {
    const total = allPreviewEntries().length;
    if (total <= PREVIEW_COUNT) return 0;
    return Math.min(Math.max(activeErrorIndex() - PREVIEW_CENTER, 0), total - PREVIEW_COUNT);
  });

  const errorPreviewEntries = createMemo(() =>
    allPreviewEntries().slice(previewStart(), previewStart() + PREVIEW_COUNT)
  );
  const activeErrorEntry = createMemo(
    () => allPreviewEntries()[activeErrorIndex()] ?? allPreviewEntries()[0] ?? null
  );
  const previewTone = createMemo(() => {
    const toneClass = errorTone(activeErrorEntry());
    return toneClass === "text-foreground" ? "text-foreground/80" : toneClass;
  });

  function dotClass(entry: ErrorPreviewEntry, isActive: boolean): string {
    const toneClass = errorTone(entry);

    if (isActive) {
      if (toneClass === "text-red-500") return "w-4 bg-red-500";
      if (toneClass === "text-amber-400") return "w-4 bg-amber-400";
      if (toneClass === "text-muted-foreground") return "w-4 bg-muted-foreground/55";
      return "w-4 bg-foreground/70";
    }

    if (toneClass === "text-red-500") return "w-1.5 bg-red-500/35";
    if (toneClass === "text-amber-400") return "w-1.5 bg-amber-400/35";
    return "w-1.5 bg-muted-foreground/35";
  }

  const displayErrorMessage = () => {
    const entry = activeErrorEntry();
    return entry ? stripStatus(entry.errorMessage, entry.errorCode) : "";
  };
  const errorDetails = () => {
    const entry = activeErrorEntry();
    return entry ? parseMessage(entry.errorMessage, entry.errorCode) : null;
  };
  const errorPlaygroundRoute = createMemo(() => {
    const details = errorDetails();
    const query: Record<string, string> = { accountId: props.account.id };
    const model = details?.model?.trim();
    const endpoint = normalizeEndpoint(details?.endpoint);
    const params = parseParams(details?.parameters);

    if (model) query.model = model;
    if (endpoint) query.endpoint = endpoint;
    if (params) {
      addParam(query, params, "stream");
      addParam(query, params, "temperature");
      addParam(query, params, "top_p");
      addParam(query, params, "max_tokens", ["max_output_tokens", "max_completion_tokens"]);
      addParam(query, params, "presence_penalty");
      addParam(query, params, "frequency_penalty");
      addParam(query, params, "reasoning_effort");

      const outputConfig = params.output_config;
      if (!query.reasoning_effort && outputConfig && typeof outputConfig === "object" && !Array.isArray(outputConfig)) {
        const effort = (outputConfig as Record<string, unknown>).effort;
        if (typeof effort === "string" && effort.trim()) query.reasoning_effort = effort.trim();
      }

      const reasoning = params.reasoning;
      if (!query.reasoning_effort && reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
        const effort = (reasoning as Record<string, unknown>).effort;
        if (typeof effort === "string" && effort.trim()) query.reasoning_effort = effort.trim();
      }

      addParams(query, params);
    }

    return { path: Routes.playground, query };
  });

  const hasPrevious = () => activeErrorIndex() < allPreviewEntries().length - 1;
  const hasNewer = () => activeErrorIndex() > 0;

  createEffect(
    on(
      () => [props.account.id, props.account.lastErrorAt] as const,
      () => {
        if (!errorDialogOpen() && activeErrorIndex() === 0) setActiveErrorIndex(0);
      }
    )
  );

  createEffect(
    on([statMetrics, animKey, () => props.animateDeltas], ([items, contextKey, animateDeltas]) => {
      const nextValues = statValues(items);

      if (animateDeltas === false) {
        setPreviousStatValues(nextValues);
        setPrevAnimKey(contextKey);
        setPendingBaselineKey(null);
        setStatHitEffects({});
        return;
      }

      const previousValues = previousStatValues();
      const previousContextKey = prevAnimKey();
      const contextChanged = previousContextKey !== contextKey;

      if (contextChanged) {
        setPreviousStatValues(nextValues);
        setPrevAnimKey(contextKey);
        setPendingBaselineKey(previousContextKey === null ? null : contextKey);
        setStatHitEffects({});
        return;
      }

      if (!previousValues || pendingBaselineKey() === contextKey) {
        setPreviousStatValues(nextValues);
        setPendingBaselineKey(null);
        return;
      }

      const nextHitEffects = { ...statHitEffects() };

      for (const item of items) {
        const currentValue = nextValues[item.key];
        const previousValue = previousValues[item.key];

        if (currentValue === undefined || previousValue === undefined) continue;

        const delta = currentValue - previousValue;
        if (!Number.isFinite(delta) || Math.abs(delta) < 0.0001) continue;

        nextHitEffects[item.key] = {
          text: item.formatDelta(delta),
          tone: item.getTone?.(delta) ?? (delta > 0 ? "positive" : "negative"),
          version: (nextHitEffects[item.key]?.version ?? 0) + 1,
        };
      }

      setPreviousStatValues(nextValues);
      setPrevAnimKey(contextKey);
      setStatHitEffects(nextHitEffects);
    })
  );

  createEffect(
    on(allPreviewEntries, (entries) => {
      if (activeErrorIndex() >= entries.length) setActiveErrorIndex(Math.max(0, entries.length - 1));
    })
  );

  function barColor(group: QuotaGroupDisplay): string {
    if (!props.account.isActive) return "bg-muted-foreground/50";
    const percent = percentRemaining(group);
    if (percent <= 10) return "bg-red-500";
    if (percent <= 25) return "bg-orange-500";
    if (percent <= 50) return "bg-yellow-500";
    return "bg-green-500";
  }

  function textColor(group: QuotaGroupDisplay): string {
    if (!props.account.isActive) return "text-muted-foreground";
    const percent = percentRemaining(group);
    if (percent <= 10) return "text-red-400";
    if (percent <= 25) return "text-orange-400";
    if (percent <= 50) return "text-yellow-400";
    return "text-green-400";
  }

  async function resolveErrors() {
    setResolvingErrors(true);
    const resolved = await settle(() => api.accounts.resolveErrors({ accountId: props.account.id }));
    setResolvingErrors(false);
    if (!resolved.ok || !resolved.value.success) return;
    setErrorDialogOpen(false);
    setActiveErrorIndex(0);
    props.onErrorsResolved(props.account.id);
  }

  async function copyText(value: string): Promise<boolean> {
    const copied = await settle(() => navigator.clipboard.writeText(value));
    return copied.ok;
  }

  function resetFlag(flag: (value: boolean) => void) {
    setTimeout(() => flag(false), 1500);
  }

  async function copyPreview(event: Event) {
    event.stopPropagation();
    event.preventDefault();
    const entry = activeErrorEntry();
    if (!entry || !(await copyText(entry.errorMessage))) return;
    setCopiedErrorPreview(true);
    resetFlag(setCopiedErrorPreview);
  }

  async function copyDetails() {
    const entry = activeErrorEntry();
    if (!entry || !(await copyText(entry.errorMessage))) return;
    setCopiedErrorDetails(true);
    resetFlag(setCopiedErrorDetails);
  }

  async function copyErrors() {
    const parts: string[] = [];
    const entries = historyEntries();
    if (entries && entries.length > 0) {
      for (const entry of entries) {
        parts.push(
          `[${entry.errorCode ? `HTTP ${entry.errorCode}` : "No code"} - ${new Date(entry.createdAt).toLocaleString()}]\n${entry.errorMessage}`
        );
      }
    }

    if (parts.length === 0) return;
    if (!(await copyText(parts.join("\n\n---\n\n")))) return;
    setCopiedAllErrors(true);
    resetFlag(setCopiedAllErrors);
  }

  async function copySession() {
    setSessionLoading(true);
    const result = await api.accounts.copySession({ id: props.account.id });
    if (!result.success || !(await copyText(result.data.session))) {
      setSessionLoading(false);
      return;
    }
    setCopiedSession(true);
    resetFlag(setCopiedSession);
    setSessionLoading(false);
  }

  function showNewer(event?: Event) {
    event?.stopPropagation();
    setActiveErrorIndex(Math.max(0, activeErrorIndex() - 1));
  }

  function showPrevious(event?: Event) {
    event?.stopPropagation();
    setActiveErrorIndex(Math.min(allPreviewEntries().length - 1, activeErrorIndex() + 1));
  }

  function openDialog() {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    setErrorDialogOpen(true);
  }

  function dragDown(event: PointerEvent) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    dragStartX = event.clientX;
  }

  function dragUp(event: PointerEvent) {
    if (dragStartX === null) return;
    const deltaX = event.clientX - dragStartX;
    dragStartX = null;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD) return;

    suppressClick = true;
    if (deltaX < 0) showPrevious(event);
    else showNewer(event);
  }

  function cancelDrag() {
    dragStartX = null;
  }

  function openPlayground(query: Record<string, string>) {
    const params = new URLSearchParams(query).toString();
    navigate(`${Routes.playground}?${params}`);
  }

  return (
    <div class="h-full">
      <UiCard
        class={`flex h-full flex-col bg-transparent transition-[border-color,box-shadow] duration-[1800ms] ease-out ${
          !props.account.isActive ? "opacity-65 " : ""
        }${props.highlight ? "border-primary shadow-[0_0_0_3px_var(--primary)]" : "border-border shadow-none"}`}
      >
        <UiCardHeader class="pb-1">
          <div class="flex min-w-0 items-center justify-between gap-2">
            <UiCardTitle class="min-w-0 truncate text-lg">{accountTitle()}</UiCardTitle>
            <div class="flex shrink-0 items-center justify-end gap-1 whitespace-nowrap">
              <Show when={showTierBadge()}>
                <UiBadge
                  variant="outline"
                  class={paidTier(normalizedTier(), props.account.provider) ? "border-green-500 text-green-600" : ""}
                >
                  {tierBadgeLabel()}
                </UiBadge>
              </Show>
              <Show
                when={props.account.status === "failed"}
                fallback={
                  <Show when={props.account.unhealthyCount > 0}>
                    <UiBadge variant="outline" class="border-yellow-500 text-yellow-600 gap-1">
                      <UiIcon name="i-lucide-triangle-alert" class="size-3" />
                      {props.account.unhealthyCount}
                    </UiBadge>
                  </Show>
                }
              >
                <UiBadge variant="outline" class="border-destructive/60 text-destructive gap-1">
                  <UiIcon name="i-lucide-alert-circle" class="size-3" />
                  {props.account.unhealthyCount}
                </UiBadge>
              </Show>
            </div>
          </div>
          <Show when={subtitleDisplay()}>
            <div class={`flex min-w-0 items-center gap-1 ${isSubtitleVisible() ? "" : "w-full overflow-hidden"}`}>
              <UiTooltip text={isSubtitleVisible() ? "Hide" : "Show"}>
                <UiButton
                  variant="ghost"
                  size="icon-sm"
                  class="h-7 w-7 shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                  aria-label={`${isSubtitleVisible() ? "Hide" : "Show"} account email for ${accountTitle()}`}
                  onClick={() => setIsSubtitleVisible(!isSubtitleVisible())}
                >
                  <UiIcon name={isSubtitleVisible() ? "i-lucide-eye-off" : "i-lucide-eye"} class="size-3.5" />
                </UiButton>
              </UiTooltip>
              <p title={subtitleDisplay() ?? ""} class="min-w-0 truncate whitespace-nowrap font-mono text-sm text-muted-foreground">
                {subtitleDisplay()}
              </p>
            </div>
          </Show>
        </UiCardHeader>

        <Show
          when={props.visible}
          fallback={
            <UiCardContent class="flex flex-1 flex-col pt-0" aria-hidden="true">
              <div class="min-h-[26rem]" />
            </UiCardContent>
          }
        >
          <UiCardContent class="flex flex-1 flex-col pt-0">
            <div class="flex-1 space-y-2 text-sm">
              <div class="mb-3">
                <div class="mb-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)] gap-1.5">
                  <For each={usageStats()}>
                    {(stat) => (
                      <UsageStatMetric
                        label={stat.label}
                        value={stat.value}
                        delta={stat.hit?.text}
                        deltaKey={stat.hit?.version}
                        deltaTone={stat.hit?.tone}
                      />
                    )}
                  </For>
                </div>
                <div class="mb-2">
                  <UsageSparkline
                    values={durationValues()}
                    color={chartColorAlt()}
                    ariaLabel={`Average duration trend for ${accountTitle()} over last 24 hours`}
                    class="h-6"
                    height={24}
                  />
                  <div class="mt-0.5 grid grid-cols-5 text-[9px]">
                    <For each={durationLabelPoints()}>
                      {(point) => (
                        <span class={`truncate text-center ${prevDay(point.time) ? "text-muted-foreground" : "text-foreground/80"}`}>
                          {hourLabel(point.time)}
                        </span>
                      )}
                    </For>
                  </div>
                </div>
                <UsageSparkline values={dailyValues()} color={usageChartColor()} ariaLabel={`Requests trend for ${accountTitle()}`} />
              </div>

              <div class="flex justify-between">
                <span class="text-muted-foreground">Last used</span>
                <span class="font-medium">
                  {props.account.lastUsedAt ? relativeTime(props.account.lastUsedAt) : "-"}
                </span>
              </div>

              <div class={`min-h-14 ${activeErrorEntry() ? "" : "hidden sm:block"}`}>
                <div class="space-y-1.5 pt-2">
                  <div class="h-32 pb-1">
                    <Show
                      when={activeErrorEntry()}
                      fallback={
                        <div class="flex h-full w-full items-center justify-center rounded-sm border border-border/60 bg-muted/20 px-2 text-center text-xs text-muted-foreground">
                          No data
                        </div>
                      }
                    >
                      <div
                        tabindex="-1"
                        class="flex h-full cursor-pointer touch-pan-y flex-col rounded-sm border border-border/60 bg-muted/30 px-2 pt-2 pb-2 text-left select-none hover:bg-muted/40"
                        onClick={openDialog}
                        onPointerDown={dragDown}
                        onPointerUp={dragUp}
                        onPointerLeave={cancelDrag}
                        onPointerCancel={cancelDrag}
                      >
                        <div class="flex items-center justify-between gap-1">
                          <Show
                            when={errorStatus(activeErrorEntry() as ErrorPreviewEntry)}
                            fallback={<span class="text-xs text-muted-foreground">No status code</span>}
                          >
                            {(status) => (
                              <span class="flex min-w-0 items-center gap-1.5">
                                <UiBadge variant="outline" class="h-5 shrink-0 px-1.5 py-0 text-[10px] font-medium">
                                  {status().code}
                                </UiBadge>
                                <span class="truncate text-xs text-muted-foreground">{status().label}</span>
                              </span>
                            )}
                          </Show>
                          <UiTooltip text="Copy">
                            <button
                              type="button"
                              class="shrink-0 cursor-pointer rounded p-0.5"
                              aria-label="Copy error message"
                              onClick={(event) => void copyPreview(event)}
                            >
                              <UiIcon
                                name={copiedErrorPreview() ? "i-lucide-check" : "i-lucide-copy"}
                                class="size-3 text-muted-foreground"
                              />
                            </button>
                          </UiTooltip>
                        </div>
                        <div class="mt-1 flex min-h-0 flex-1 items-center">
                          <span class={`line-clamp-4 break-all text-xs ${previewTone()}`}>
                            {errorPreview(activeErrorEntry() as ErrorPreviewEntry)}
                          </span>
                        </div>
                        <div class="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground/80">
                          <span>{errorTime(activeErrorEntry() as ErrorPreviewEntry)}</span>
                          <span class="min-w-0 truncate text-right font-mono">{activeErrorEntry()?.model}</span>
                        </div>
                      </div>
                    </Show>
                  </div>

                  <div class="flex items-center justify-between gap-2">
                    <UiTooltip text="Newer">
                      <UiButton
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        class="h-6 w-6"
                        disabled={!hasNewer()}
                        aria-label="Show newer error"
                        onClick={showNewer}
                      >
                        <UiIcon name="i-lucide-chevron-left" class="size-3.5" />
                      </UiButton>
                    </UiTooltip>
                    <div class="flex min-w-0 flex-1 items-center justify-center gap-1">
                      <Show
                        when={!historyError()}
                        fallback={<span class="truncate text-[10px] text-red-500">{historyError()}</span>}
                      >
                        <For each={errorPreviewEntries()}>
                          {(entry, index) => (
                            <span class={`h-1.5 rounded-full ${dotClass(entry, previewStart() + index() === activeErrorIndex())}`} />
                          )}
                        </For>
                      </Show>
                    </div>
                    <UiTooltip text="Older">
                      <UiButton
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        class="h-6 w-6"
                        disabled={!hasPrevious()}
                        aria-label="Show previous error"
                        onClick={showPrevious}
                      >
                        <UiIcon name="i-lucide-chevron-right" class="size-3.5" />
                      </UiButton>
                    </UiTooltip>
                  </div>
                </div>
              </div>

              <Show when={supportsQuotaMonitor() && (props.quotaInfo || props.quotaError)}>
                <div class="mt-3 space-y-2 border-t pt-3">
                  <div>
                    <span class="text-xs font-medium text-muted-foreground">Quota</span>
                  </div>

                  <Show
                    when={props.quotaInfo?.status === "success" && (props.quotaInfo?.groups.length ?? 0) > 0}
                    fallback={<p class="text-xs text-red-500">{props.quotaError ?? props.quotaInfo?.error ?? "Failed to fetch quota data."}</p>}
                  >
                    <div class="space-y-2">
                      <For each={props.quotaInfo?.groups ?? []}>
                        {(group) => (
                          <div class="space-y-1">
                            <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs">
                              <span class="min-w-0 overflow-hidden truncate text-muted-foreground">{group.displayName}</span>
                              <span class="flex min-w-0 max-w-28 shrink-0 items-center justify-end gap-1.5 overflow-hidden">
                                <Show when={group.resetInHuman}>
                                  <UiTooltip text={resetTitle(group) ?? ""}>
                                    <span class="block max-w-20 truncate text-[10px] text-muted-foreground">
                                      {group.resetInHuman}
                                    </span>
                                  </UiTooltip>
                                </Show>
                                <span class={`shrink-0 font-mono ${textColor(group)}`}>{percentRemaining(group)}%</span>
                              </span>
                            </div>
                            <div class="h-1.5 overflow-hidden rounded-full bg-muted">
                              <div
                                class={`h-full transition-all duration-300 ${barColor(group)}`}
                                style={{ width: `${percentRemaining(group)}%` }}
                              />
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>

              <Show when={(props.supportedModels?.length ?? 0) > 0}>
                <AccountModelAccess
                  accountId={props.account.id}
                  provider={props.account.provider}
                  supportedModels={props.supportedModels ?? []}
                  initialDisabledModels={props.disabledModels ?? []}
                  modelHealth={props.modelHealth ?? {}}
                  readonly={props.readonly}
                />
              </Show>
            </div>

            <div class="mt-4 flex items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <UiTooltip text="Edit" disabled={props.readonly}>
                  <UiButton
                    variant="outline"
                    size="sm"
                    disabled={props.readonly}
                    aria-label={`Edit ${accountTitle()}`}
                    onClick={() => setEditDialogOpen(true)}
                  >
                    <UiIcon name="i-lucide-pencil" class="size-3" />
                  </UiButton>
                </UiTooltip>
                <UiTooltip text="Delete" disabled={props.readonly}>
                  <UiButton
                    variant="outline"
                    size="sm"
                    disabled={props.readonly}
                    aria-label={`Delete ${accountTitle()}`}
                    onClick={() => setDeleteDialogOpen(true)}
                  >
                    <UiIcon name="i-lucide-trash-2" class="size-3 text-destructive" />
                  </UiButton>
                </UiTooltip>
                <UiTooltip text="Playground">
                  <UiButton
                    variant="outline"
                    size="sm"
                    onClick={() => openPlayground({ accountId: props.account.id })}
                  >
                    <UiIcon name="i-lucide-flask-conical" class="size-3" />
                  </UiButton>
                </UiTooltip>
                <Show when={isMaintainer()}>
                  <UiTooltip text={sessionLoading() ? "Fetching session..." : copiedSession() ? "Copied" : "Copy session"}>
                    <UiButton
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={props.readonly || sessionLoading()}
                      aria-label={`Copy session for ${accountTitle()}`}
                      onClick={() => void copySession()}
                    >
                      <UiIcon
                        name={sessionLoading() ? "i-lucide-loader-2" : copiedSession() ? "i-lucide-check" : "i-lucide-key-round"}
                        class={sessionLoading() ? "size-3 animate-spin" : "size-3"}
                      />
                    </UiButton>
                  </UiTooltip>
                </Show>
              </div>
              <div class="flex shrink-0 items-center gap-1.5">
                <UiTooltip text={accountStatusTitle()}>
                  <span class="max-w-32 truncate text-[11px] text-muted-foreground">{accountStatusLabel()}</span>
                </UiTooltip>
                <UiSwitch
                  checked={props.account.isActive}
                  disabled={(props.readonly ?? false) || actions.isToggling() || actions.isTemporaryDisabling()}
                  title={props.account.isActive ? "Disable" : "Enable"}
                  onPointerDown={actions.startLongPress}
                  onPointerUp={actions.finishLongPress}
                  onPointerLeave={actions.finishLongPress}
                  onPointerCancel={actions.finishLongPress}
                  onClickCapture={actions.toggleClick}
                  onCheckedChange={() => void actions.toggleActive()}
                />
              </div>
            </div>
          </UiCardContent>
        </Show>
      </UiCard>

      <UiDialog
        open={actions.dialogOpen()}
        onOpenChange={actions.setDialogOpen}
        ui={{ content: "sm:max-w-md" }}
        content={
          <>
            <div class="space-y-1.5 pr-6">
              <h2 class="text-lg font-semibold">Disable Temporarily</h2>
              <p class="text-sm text-muted-foreground">Choose how long "{props.account.name}" should stay off.</p>
            </div>

            <div class="grid gap-3 sm:grid-cols-[1fr_auto]">
              <label class="grid gap-1 text-sm font-medium">
                Duration
                <input
                  value={actions.temporaryOffAmount()}
                  type="number"
                  min="1"
                  step="1"
                  class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  onInput={(event) => actions.setTemporaryOffAmount(Number(event.currentTarget.value))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void actions.disableTemporarily();
                    }
                  }}
                />
              </label>
              <label class="grid gap-1 text-sm font-medium">
                Unit
                <select
                  value={actions.temporaryOffUnit()}
                  class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  onChange={(event) => actions.setTemporaryOffUnit(event.currentTarget.value as "minutes" | "hours" | "days")}
                >
                  <For each={TEMPORARY_OFF_UNITS}>{(unit) => <option value={unit.value}>{unit.label}</option>}</For>
                </select>
              </label>
            </div>

            <p class="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              This account will turn back on {temporaryOffPreview()}.
            </p>
            <Show when={actions.temporaryOffError()}>
              <p class="text-sm text-red-500">{actions.temporaryOffError()}</p>
            </Show>
            <div class="flex justify-end gap-2">
              <UiButton variant="outline" disabled={actions.isTemporaryDisabling()} onClick={() => actions.setDialogOpen(false)}>
                Cancel
              </UiButton>
              <UiButton disabled={actions.isTemporaryDisabling()} onClick={() => void actions.disableTemporarily()}>
                {actions.isTemporaryDisabling() ? "Disabling..." : "Disable"}
              </UiButton>
            </div>
          </>
        }
      />

      <UiDialog
        open={editDialogOpen()}
        onOpenChange={setEditDialogOpen}
        ui={{ content: "sm:max-w-md" }}
        content={
          <>
            <label class="grid gap-1 text-sm font-medium">
              <span>
                Name <span class="text-destructive">*</span>
              </span>
              <input
                value={actions.editName()}
                class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                onInput={(event) => actions.setEditName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void actions.renameAccount();
                  }
                }}
              />
            </label>
            <div class="flex justify-end gap-2">
              <UiButton variant="outline" onClick={() => setEditDialogOpen(false)}>
                Cancel
              </UiButton>
              <UiButton disabled={actions.savingName()} onClick={() => void actions.renameAccount()}>
                {actions.savingName() ? "Saving..." : "Save"}
              </UiButton>
            </div>
          </>
        }
      />

      <UiDialog
        open={deleteDialogOpen()}
        onOpenChange={setDeleteDialogOpen}
        ui={{ content: "sm:max-w-md" }}
        content={
          <>
            <div class="space-y-1.5 pr-6">
              <h2 class="text-lg font-semibold">Delete Account</h2>
              <p class="text-sm text-muted-foreground">
                Delete <strong class="font-semibold text-foreground">{props.account.name}</strong> — this cannot be undone.
              </p>
            </div>
            <div class="flex justify-end gap-2">
              <UiButton variant="outline" onClick={() => setDeleteDialogOpen(false)}>
                Cancel
              </UiButton>
              <UiButton variant="destructive" disabled={actions.deleting()} onClick={() => void actions.deleteAccount()}>
                {actions.deleting() ? "Deleting..." : "Delete"}
              </UiButton>
            </div>
          </>
        }
      />

      <UiDialog
        open={errorDialogOpen()}
        onOpenChange={setErrorDialogOpen}
        showClose={false}
        ui={{ content: "sm:max-w-xl" }}
        content={
          <>
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-1">
                <UiTooltip text="Copy all">
                  <UiButton type="button" variant="outline" size="icon-sm" aria-label="Copy all errors" onClick={() => void copyErrors()}>
                    <UiIcon name={copiedAllErrors() ? "i-lucide-check" : "i-lucide-clipboard-list"} class="size-4" />
                  </UiButton>
                </UiTooltip>
                <UiTooltip text="Copy">
                  <UiButton type="button" variant="outline" size="icon-sm" aria-label="Copy error details" onClick={() => void copyDetails()}>
                    <UiIcon name={copiedErrorDetails() ? "i-lucide-check" : "i-lucide-copy"} class="size-4" />
                  </UiButton>
                </UiTooltip>
                <UiTooltip text="Playground">
                  <UiButton
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="Open in Playground"
                    onClick={() => {
                      const route = errorPlaygroundRoute();
                      openPlayground(route.query);
                    }}
                  >
                    <UiIcon name="i-lucide-flask-conical" class="size-4" />
                  </UiButton>
                </UiTooltip>
                <UiTooltip text="Resolve">
                  <UiButton
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="Resolve errors"
                    disabled={resolvingErrors()}
                    onClick={() => void resolveErrors()}
                  >
                    <UiIcon name="i-lucide-check-circle" class="size-4 text-green-600" />
                  </UiButton>
                </UiTooltip>
              </div>
              <UiTooltip text="Close">
                <UiButton
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close error details"
                  class="shrink-0"
                  onClick={() => setErrorDialogOpen(false)}
                >
                  <UiIcon name="i-lucide-x" class="size-4" />
                </UiButton>
              </UiTooltip>
            </div>

            <div class="max-h-[60vh] space-y-3 overflow-y-auto rounded-md border bg-muted/20 p-3">
              <Show when={errorDetails() && (errorDetails()?.provider || errorDetails()?.endpoint || errorDetails()?.model)}>
                <div class="rounded-md border bg-background/70 p-2">
                  <Show when={errorDetails()?.provider}>
                    <p class="text-xs">
                      <span class="text-muted-foreground">Provider:</span>{" "}
                      <span class="font-mono">{errorDetails()?.provider}</span>
                    </p>
                  </Show>
                  <Show when={errorDetails()?.endpoint}>
                    <p class="text-xs">
                      <span class="text-muted-foreground">Endpoint:</span>{" "}
                      <span class="font-mono">{errorDetails()?.endpoint}</span>
                    </p>
                  </Show>
                  <Show when={errorDetails()?.model}>
                    <p class="text-xs">
                      <span class="text-muted-foreground">Model:</span>{" "}
                      <span class="font-mono">{errorDetails()?.model}</span>
                    </p>
                  </Show>
                </div>
              </Show>

              <Show when={errorDetails()?.error}>
                <div>
                  <p class="mb-1 text-xs text-muted-foreground">Error</p>
                  <p class="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{errorDetails()?.error}</p>
                </div>
              </Show>

              <Show when={errorDetails()?.parameters}>
                <div>
                  <p class="mb-1 text-xs text-muted-foreground">Body Parameters</p>
                  <p class="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{errorDetails()?.parameters}</p>
                </div>
              </Show>

              <Show when={(errorDetails()?.messageObjects?.length ?? 0) > 0}>
                <div>
                  <p class="mb-1 text-xs text-muted-foreground">Messages (object keys only)</p>
                  <p class="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                    {(errorDetails()?.messageObjects ?? []).join("\n")}
                  </p>
                </div>
              </Show>

              <Show
                when={
                  errorDetails() &&
                  !errorDetails()?.error &&
                  !errorDetails()?.parameters &&
                  (errorDetails()?.messageObjects?.length ?? 0) === 0
                }
              >
                <p class="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{displayErrorMessage()}</p>
              </Show>
            </div>
          </>
        }
      />
    </div>
  );
}
