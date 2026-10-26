<script setup lang="ts">
import { settle } from "~~/lib/settle";
import {
  messageModel,
  isRecoverable,
  normalizeEndpoint,
  addParams,
  addParam,
  parseParams,
  parseMessage,
  stripStatus,
} from "~~/lib/account-errors";
import {
  statValues,
  compactNumber,
  dailyPoints,
  durationPoints,
  dateTime,
  formatDuration,
  hourLabel,
  relativeTime,
  signedDuration,
  signedInteger,
  signedPercent,
  tierLabel,
  accountHeader,
  errorPreview,
  errorTime,
  errorStatus,
  paidTier,
  prevDay,
  maskText,
  timeOf,
  type Account,
  type DurationPoint,
  type ErrorPreviewEntry,
  type StatDeltaTone,
  type StatMetric,
} from "~~/lib/account-format";
import { percentRemaining, resetTitle } from "~~/lib/quota-display";

import type { AccountQuotaInfo, ErrorHistoryResult, AccountUpdateData, ProviderDetailData, QuotaGroupDisplay } from "~~/lib/api-types";
import { QUOTA_PROVIDER_KEYS } from "@opendum/providers/provider-accounts";


type ErrorHistoryEntry = Extract<ErrorHistoryResult, { success: true }>["data"]["entries"][number];






type StatHit = { text: string; tone: StatDeltaTone; version: number };





const QUOTA_PROVIDERS = new Set<string>(QUOTA_PROVIDER_KEYS);
const SWIPE_THRESHOLD = 45;
const PREVIEW_COUNT = 9;
const PREVIEW_CENTER = 4;


const props = defineProps<{
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
}>();

const emit = defineEmits<{
  renamed: [account: AccountUpdateData];
  "active-updated": [account: AccountUpdateData];
  "temporarily-disabled": [account: AccountUpdateData];
  deleted: [accountId: string];
  "errors-resolved": [accountId: string];
}>();

const api = useApi();
const { auditRefreshVersion, auditUser, me, isAuditMode } = useAudit();
const {
  TEMPORARY_OFF_UNITS,
  isToggling,
  isTemporaryDisabling,
  savingName,
  deleting,
  editName,
  temporaryOffAmount,
  temporaryOffUnit,
  temporaryOffError,
  dialogOpen,
  offUntil,
  startLongPress,
  finishLongPress,
  toggleClick,
  toggleActive,
  disableTemporarily,
  renameAccount,
  deleteAccount,
} = useAccountActions(props, {
  onActiveUpdated: (data) => emit("active-updated", data),
  onTemporarilyDisabled: (data) => emit("temporarily-disabled", data),
  onRenamed: (data) => {
    editDialogOpen.value = false;
    emit("renamed", data);
  },
  onDeleted: (id) => {
    deleteDialogOpen.value = false;
    emit("deleted", id);
  },
});
const isSubtitleVisible = ref(true);
const editDialogOpen = ref(false);
const deleteDialogOpen = ref(false);
const errorDialogOpen = ref(false);
const resolvingErrors = ref(false);
const copiedErrorDetails = ref(false);
const copiedAllErrors = ref(false);
const copiedErrorPreview = ref(false);
const isMaintainer = computed(() => import.meta.dev || (me.value?.isMaintainer ?? false));
const copiedSession = ref(false);
const sessionLoading = ref(false);
const statHitEffects = ref<Record<string, StatHit>>({});
const previousStatValues = ref<Record<string, number> | null>(null);
const prevAnimKey = ref<string | null>(null);
const pendingBaselineKey = ref<string | null>(null);
const activeErrorIndex = ref(0);
const cardRoot = ref<HTMLElement | null>(null);
let dragStartX: number | null = null;
let suppressClick = false;

























































const header = computed(() => accountHeader(props.account));
const accountTitle = computed(() => header.value.title || "Provider account");
const historyError = computed(() => props.errorHistoryError ?? null);
const historyEntries = computed(() => props.errorHistory ?? null);
const subtitle = computed(() => {
  return header.value.subtitle;
});
const subtitleDisplay = computed(() => (subtitle.value ? (isSubtitleVisible.value ? subtitle.value : maskText(subtitle.value)) : null));
const daily = computed(() => dailyPoints(props.account.stats.dailyRequests));
const dailyValues = computed(() => daily.value.map((point) => point.count));
const duration = computed(() => durationPoints(props.account.stats.durationLast24Hours));
const durationValues = computed(() => duration.value.map((point) => point.avgDuration ?? 0));
const durationLabelPoints = computed(() => {
  const points = duration.value;
  const tickCount = Math.min(5, points.length);
  const indexes = Array.from(new Set(Array.from({ length: tickCount }, (_, index) => Math.round((index / (tickCount - 1 || 1)) * (points.length - 1)))));
  return indexes.map((index) => points[index]).filter(Boolean) as DurationPoint[];
});
const statMetrics = computed<StatMetric[]>(() => [
  { key: "totalRequests", label: "Requests", value: props.account.stats.totalRequests.toLocaleString(), numericValue: props.account.stats.totalRequests, formatDelta: signedInteger },
  { key: "totalTokens", label: "Token", value: compactNumber(props.account.stats.totalTokens), numericValue: props.account.stats.totalTokens, formatDelta: signedInteger },
  { key: "successRate", label: "Success", value: props.account.stats.successRate === null ? "-" : `${props.account.stats.successRate}%`, numericValue: props.account.stats.successRate ?? Number.NaN, formatDelta: signedPercent },
  { key: "avgDuration", label: "Latency", value: formatDuration(props.account.stats.avgDurationLastDay), numericValue: props.account.stats.avgDurationLastDay ?? Number.NaN, formatDelta: signedDuration, getTone: (delta) => delta > 0 ? "negative" : "positive" },
]);
const animKey = computed(() => {
  const userKey = isAuditMode.value ? `audit:${auditUser.value?.id ?? ""}` : "self";
  return `${props.account.id}:${userKey}:${auditRefreshVersion.value}`;
});
const usageStats = computed(() => statMetrics.value.map((stat) => ({ ...stat, hit: props.animateDeltas === false ? undefined : statHitEffects.value[stat.key] })));
const effectiveTier = computed(() => props.account.tier);
const normalizedTier = computed(() => effectiveTier.value?.trim().toLowerCase() || "");
const tierBadgeLabel = computed(() => tierLabel(normalizedTier.value, props.account.provider));
const showTierBadge = computed(() => props.showTier && tierBadgeLabel.value !== "");
const supportsQuotaMonitor = computed(() => QUOTA_PROVIDERS.has(props.account.provider));
const usageChartColor = computed(() => props.account.isActive ? "var(--chart-1)" : "var(--muted-foreground)");
const chartColorAlt = computed(() => props.account.isActive ? "var(--chart-2)" : "var(--muted-foreground)");
const activeDisabledUntil = computed(() => {
  if (!props.account.disabledUntil) return null;

  const disabledUntil = new Date(props.account.disabledUntil);
  if (Number.isNaN(disabledUntil.getTime()) || disabledUntil <= new Date()) return null;
  return disabledUntil;
});
const accountStatusLabel = computed(() => {
  if (activeDisabledUntil.value) return `Cooldown ${relativeTime(activeDisabledUntil.value).replace(/^in\s+/, "")}`;
  return props.account.isActive ? "On" : "Off";
});
const accountStatusTitle = computed(() => activeDisabledUntil.value ? `Temporarily disabled until ${activeDisabledUntil.value.toLocaleString()}` : undefined);
const temporaryOffPreview = computed(() => {
  const until = offUntil();
  if (!until) return "Select a valid future duration.";
  return `${relativeTime(until)} (${dateTime(until)})`;
});
function recoveredAt(): number {
  return Math.max(timeOf(props.account.lastSuccessAt) ?? 0, timeOf(props.account.lastRecoveredAt) ?? 0, timeOf(props.account.lastUsedAt) ?? 0);
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

const allPreviewEntries = computed<ErrorPreviewEntry[]>(() => {
  return (historyEntries.value ?? [])
    .map((entry) => ({
      id: entry.id,
      model: entry.model ?? messageModel(entry.errorMessage, entry.errorCode),
      errorCode: entry.errorCode,
      errorMessage: entry.errorMessage,
      createdAt: entry.createdAt,
    }))
    .sort((a, b) => (timeOf(b.createdAt) ?? 0) - (timeOf(a.createdAt) ?? 0));
});
const previewStart = computed(() => {
  const total = allPreviewEntries.value.length;
  if (total <= PREVIEW_COUNT) return 0;

  return Math.min(Math.max(activeErrorIndex.value - PREVIEW_CENTER, 0), total - PREVIEW_COUNT);
});
const errorPreviewEntries = computed<ErrorPreviewEntry[]>(() => allPreviewEntries.value.slice(previewStart.value, previewStart.value + PREVIEW_COUNT));
const activeErrorEntry = computed<ErrorPreviewEntry | null>(() => allPreviewEntries.value[activeErrorIndex.value] ?? allPreviewEntries.value[0] ?? null);
const previewTone = computed(() => {
  const toneClass = errorTone(activeErrorEntry.value);
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

const displayErrorMessage = computed(() => activeErrorEntry.value ? stripStatus(activeErrorEntry.value.errorMessage, activeErrorEntry.value.errorCode) : "");
const errorDetails = computed(() => activeErrorEntry.value ? parseMessage(activeErrorEntry.value.errorMessage, activeErrorEntry.value.errorCode) : null);
const errorPlaygroundRoute = computed(() => {
  const details = errorDetails.value;
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

  return { path: "/play", query };
});
const hasPrevious = computed(() => activeErrorIndex.value < allPreviewEntries.value.length - 1);
const hasNewer = computed(() => activeErrorIndex.value > 0);

watch(
  () => [props.account.id, props.account.lastErrorAt] as const,
  () => {
    if (!errorDialogOpen.value && activeErrorIndex.value === 0) {
      activeErrorIndex.value = 0;
    }
  },
);

watch([statMetrics, animKey, () => props.animateDeltas], ([items, contextKey, animateDeltas]) => {
  const nextValues = statValues(items);

  if (animateDeltas === false) {
    previousStatValues.value = nextValues;
    prevAnimKey.value = contextKey;
    pendingBaselineKey.value = null;
    statHitEffects.value = {};
    return;
  }

  const previousValues = previousStatValues.value;
  const previousContextKey = prevAnimKey.value;
  const contextChanged = previousContextKey !== contextKey;

  if (contextChanged) {
    previousStatValues.value = nextValues;
    prevAnimKey.value = contextKey;
    pendingBaselineKey.value = previousContextKey === null ? null : contextKey;
    statHitEffects.value = {};
    return;
  }

  if (!previousValues || pendingBaselineKey.value === contextKey) {
    previousStatValues.value = nextValues;
    pendingBaselineKey.value = null;
    return;
  }

  const nextHitEffects = { ...statHitEffects.value };

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

  previousStatValues.value = nextValues;
  prevAnimKey.value = contextKey;
  statHitEffects.value = nextHitEffects;
}, { immediate: true });

watch(allPreviewEntries, (entries) => {
  if (activeErrorIndex.value >= entries.length) activeErrorIndex.value = Math.max(0, entries.length - 1);
});





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
  resolvingErrors.value = true;
  const resolved = await settle(() => api.accounts.resolveErrors({ accountId: props.account.id }));
  resolvingErrors.value = false;
  if (!resolved.ok || !resolved.value.success) return;
  errorDialogOpen.value = false;
  activeErrorIndex.value = 0;
  emit("errors-resolved", props.account.id);
}

async function copyText(value: string): Promise<boolean> {
  const copied = await settle(() => navigator.clipboard.writeText(value));
  return copied.ok;
}

function resetFlag(flag: { value: boolean }) {
  setTimeout(() => {
    flag.value = false;
  }, 1500);
}

async function copyPreview(event: Event) {
  event.stopPropagation();
  event.preventDefault();

  if (!activeErrorEntry.value || !(await copyText(activeErrorEntry.value.errorMessage))) return;
  copiedErrorPreview.value = true;
  resetFlag(copiedErrorPreview);
}

async function copyDetails() {
  if (!activeErrorEntry.value || !(await copyText(activeErrorEntry.value.errorMessage))) return;
  copiedErrorDetails.value = true;
  resetFlag(copiedErrorDetails);
}

async function copyErrors() {
  const parts: string[] = [];

  if (historyEntries.value && historyEntries.value.length > 0) {
    for (const entry of historyEntries.value) {
      parts.push(`[${entry.errorCode ? `HTTP ${entry.errorCode}` : "No code"} - ${new Date(entry.createdAt).toLocaleString()}]\n${entry.errorMessage}`);
    }
  }

  if (parts.length === 0) return;

  if (!(await copyText(parts.join("\n\n---\n\n")))) return;
  copiedAllErrors.value = true;
  resetFlag(copiedAllErrors);
}

async function copySession() {
  sessionLoading.value = true;
  {
    const result = await api.accounts.copySession({ id: props.account.id });
    if (!result.success || !(await copyText(result.data.session))) return;
    copiedSession.value = true;
    resetFlag(copiedSession);
  }
  {
    sessionLoading.value = false;
  }
}







function showNewer(event?: Event) {
  event?.stopPropagation();
  activeErrorIndex.value = Math.max(0, activeErrorIndex.value - 1);
}

function showPrevious(event?: Event) {
  event?.stopPropagation();
  activeErrorIndex.value = Math.min(allPreviewEntries.value.length - 1, activeErrorIndex.value + 1);
}

function openDialog() {
  if (suppressClick) {
    suppressClick = false;
    return;
  }

  errorDialogOpen.value = true;
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
</script>

<template>
  <div ref="cardRoot" class="h-full">
    <UiCard
      class="flex h-full flex-col bg-transparent transition-[border-color,box-shadow] duration-[1800ms] ease-out"
      :class="`${!account.isActive ? 'opacity-65 ' : ''}${highlight ? 'border-primary shadow-[0_0_0_3px_var(--primary)]' : 'border-border shadow-none'}`"
    >
      <UiCardHeader class="pb-1">
        <div class="flex min-w-0 items-center justify-between gap-2">
          <UiCardTitle class="min-w-0 truncate text-lg">{{ accountTitle }}</UiCardTitle>
          <div class="flex shrink-0 items-center justify-end gap-1 whitespace-nowrap">
            <UiBadge v-if="showTierBadge" variant="outline" :class="paidTier(normalizedTier, account.provider) ? 'border-green-500 text-green-600' : ''">
              {{ tierBadgeLabel }}
            </UiBadge>
            <UiBadge v-if="account.status === 'failed'" variant="outline" class="border-destructive/60 text-destructive gap-1">
              <UiIcon name="i-lucide-alert-circle" class="size-3" />
              {{ account.unhealthyCount }}
            </UiBadge>
            <UiBadge v-else-if="account.unhealthyCount > 0" variant="outline" class="border-yellow-500 text-yellow-600 gap-1">
              <UiIcon name="i-lucide-triangle-alert" class="size-3" />
              {{ account.unhealthyCount }}
            </UiBadge>
          </div>
        </div>
        <div v-if="subtitleDisplay" :class="['flex min-w-0 items-center gap-1', isSubtitleVisible ? '' : 'w-full overflow-hidden']">
          <UiTooltip :text="isSubtitleVisible ? 'Hide' : 'Show'">
            <UiButton
              variant="ghost"
              size="icon-sm"
              class="h-7 w-7 shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
              :aria-label="isSubtitleVisible ? `Hide account email for ${accountTitle}` : `Show account email for ${accountTitle}`"
              @click="isSubtitleVisible = !isSubtitleVisible"
            >
              <UiIcon :name="isSubtitleVisible ? 'i-lucide-eye-off' : 'i-lucide-eye'" class="size-3.5" />
            </UiButton>
          </UiTooltip>
          <p :title="subtitleDisplay" class="min-w-0 truncate whitespace-nowrap font-mono text-sm text-muted-foreground">{{ subtitleDisplay }}</p>
        </div>
      </UiCardHeader>
      <UiCardContent v-if="visible" class="flex flex-1 flex-col pt-0">
        <div class="flex-1 space-y-2 text-sm">
          <div class="mb-3">
            <div class="mb-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)] gap-1.5">
              <UsageStatMetric
                v-for="stat in usageStats"
                :key="stat.key"
                :label="stat.label"
                :value="stat.value"
                :delta="stat.hit?.text"
                :delta-key="stat.hit?.version"
                :delta-tone="stat.hit?.tone"
              />
            </div>
            <div class="mb-2">
              <UsageSparkline :values="durationValues" :color="chartColorAlt" :aria-label="`Average duration trend for ${accountTitle} over last 24 hours`" class="h-6" :height="24" />
              <div class="mt-0.5 grid grid-cols-5 text-[9px]">
                <span v-for="point in durationLabelPoints" :key="point.time" :class="['truncate text-center', prevDay(point.time) ? 'text-muted-foreground' : 'text-foreground/80']">{{ hourLabel(point.time) }}</span>
              </div>
            </div>
            <UsageSparkline :values="dailyValues" :color="usageChartColor" :aria-label="`Requests trend for ${accountTitle}`" />
          </div>

          <div class="flex justify-between"><span class="text-muted-foreground">Last used</span><span class="font-medium">{{ account.lastUsedAt ? relativeTime(account.lastUsedAt) : '-' }}</span></div>

          <div :class="['min-h-14', activeErrorEntry ? '' : 'hidden sm:block']">
            <div class="space-y-1.5 pt-2">
              <div class="h-32 pb-1">
                <div
                  v-if="activeErrorEntry"
                  tabindex="-1"
                  class="flex h-full cursor-pointer touch-pan-y flex-col rounded-sm border border-border/60 bg-muted/30 px-2 pt-2 pb-2 text-left select-none hover:bg-muted/40"
                  @click="openDialog"
                  @pointerdown="dragDown"
                  @pointerup="dragUp"
                  @pointerleave="cancelDrag"
                  @pointercancel="cancelDrag"
                >
                  <div class="flex items-center justify-between gap-1">
                    <span v-if="errorStatus(activeErrorEntry)" class="flex min-w-0 items-center gap-1.5">
                      <UiBadge variant="outline" class="h-5 shrink-0 px-1.5 py-0 text-[10px] font-medium">{{ errorStatus(activeErrorEntry)?.code }}</UiBadge>
                      <span class="truncate text-xs text-muted-foreground">{{ errorStatus(activeErrorEntry)?.label }}</span>
                    </span>
                    <span v-else class="text-xs text-muted-foreground">No status code</span>
                    <UiTooltip text="Copy">
                      <button
                        type="button"
                        class="shrink-0 cursor-pointer rounded p-0.5"
                        aria-label="Copy error message"
                        @click="copyPreview"
                      >
                        <UiIcon v-if="copiedErrorPreview" name="i-lucide-check" class="size-3 text-muted-foreground" />
                        <UiIcon v-else name="i-lucide-copy" class="size-3 text-muted-foreground" />
                      </button>
                    </UiTooltip>
                  </div>
                  <div class="mt-1 flex min-h-0 flex-1 items-center">
                    <span :class="['line-clamp-4 break-all text-xs', previewTone]">{{ errorPreview(activeErrorEntry) }}</span>
                  </div>
                  <div class="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground/80">
                    <span>{{ errorTime(activeErrorEntry) }}</span>
                    <span class="min-w-0 truncate text-right font-mono">{{ activeErrorEntry.model }}</span>
                  </div>
                </div>
                <div v-else class="flex h-full w-full items-center justify-center rounded-sm border border-border/60 bg-muted/20 px-2 text-center text-xs text-muted-foreground">
                  No data
                </div>
              </div>

              <div class="flex items-center justify-between gap-2">
                <UiTooltip text="Newer">
                  <UiButton type="button" variant="outline" size="icon-sm" class="h-6 w-6" :disabled="!hasNewer" aria-label="Show newer error" @click="showNewer">
                    <UiIcon name="i-lucide-chevron-left" class="size-3.5" />
                  </UiButton>
                </UiTooltip>
                <div class="flex min-w-0 flex-1 items-center justify-center gap-1">
                  <span v-if="historyError" class="truncate text-[10px] text-red-500">{{ historyError }}</span>
                  <template v-else>
                    <span
                      v-for="(entry, index) in errorPreviewEntries"
                      :key="index"
                      :class="['h-1.5 rounded-full', dotClass(entry, previewStart + index === activeErrorIndex)]"
                    />
                  </template>
                </div>
                <UiTooltip text="Older">
                  <UiButton type="button" variant="outline" size="icon-sm" class="h-6 w-6" :disabled="!hasPrevious" aria-label="Show previous error" @click="showPrevious">
                    <UiIcon name="i-lucide-chevron-right" class="size-3.5" />
                  </UiButton>
                </UiTooltip>
              </div>
            </div>
          </div>

          <div v-if="supportsQuotaMonitor && (quotaInfo || quotaError)" class="mt-3 space-y-2 border-t pt-3">
            <div>
              <span class="text-xs font-medium text-muted-foreground">Quota</span>
            </div>

            <p v-if="quotaError" class="text-xs text-red-500">{{ quotaError }}</p>
              <div v-else-if="quotaInfo?.status === 'success' && quotaInfo.groups.length > 0" class="space-y-2">
                <div v-for="group in quotaInfo.groups" :key="group.name" class="space-y-1">
                  <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs">
                    <span class="min-w-0 overflow-hidden truncate text-muted-foreground">{{ group.displayName }}</span>
                    <span class="flex min-w-0 max-w-28 shrink-0 items-center justify-end gap-1.5 overflow-hidden">
                      <UiTooltip v-if="group.resetInHuman" :text="resetTitle(group)">
                        <span class="block max-w-20 truncate text-[10px] text-muted-foreground">
                          {{ group.resetInHuman }}
                        </span>
                      </UiTooltip>
                      <span :class="['shrink-0 font-mono', textColor(group)]">{{ percentRemaining(group) }}%</span>
                    </span>
                  </div>
                  <div class="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div class="h-full transition-all duration-300" :class="barColor(group)" :style="{ width: `${percentRemaining(group)}%` }" />
                  </div>
                </div>
              </div>
              <p v-else class="text-xs text-red-500">{{ quotaInfo?.error ?? 'Failed to fetch quota data.' }}</p>
          </div>

          <AccountModelAccess v-if="supportedModels?.length" :account-id="account.id" :provider="account.provider" :supported-models="supportedModels" :initial-disabled-models="disabledModels ?? []" :model-health="modelHealth ?? {}" :readonly="readonly" />
        </div>
        <div class="mt-4 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <UiTooltip text="Edit" :disabled="readonly">
              <UiButton variant="outline" size="sm" :disabled="readonly" :aria-label="`Edit ${accountTitle}`" @click="editDialogOpen = true"><UiIcon name="i-lucide-pencil" class="size-3" /></UiButton>
            </UiTooltip>
            <UiTooltip text="Delete" :disabled="readonly">
              <UiButton variant="outline" size="sm" :disabled="readonly" :aria-label="`Delete ${accountTitle}`" @click="deleteDialogOpen = true"><UiIcon name="i-lucide-trash-2" class="size-3 text-destructive" /></UiButton>
            </UiTooltip>
            <UiTooltip text="Playground">
              <NuxtLink :to="`/play?accountId=${account.id}`">
                <UiButton variant="outline" size="sm"><UiIcon name="i-lucide-flask-conical" class="size-3" /></UiButton>
              </NuxtLink>
            </UiTooltip>
            <UiTooltip v-if="isMaintainer" :text="sessionLoading ? 'Fetching session...' : copiedSession ? 'Copied' : 'Copy session'">
              <UiButton type="button" variant="outline" size="sm" :disabled="readonly || sessionLoading" :aria-label="`Copy session for ${accountTitle}`" @click="copySession">
                <UiIcon :name="sessionLoading ? 'i-lucide-loader-2' : copiedSession ? 'i-lucide-check' : 'i-lucide-key-round'" :class="sessionLoading ? 'size-3 animate-spin' : 'size-3'" />
              </UiButton>
            </UiTooltip>
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            <UiTooltip :text="accountStatusTitle">
              <span class="max-w-32 truncate text-[11px] text-muted-foreground">{{ accountStatusLabel }}</span>
            </UiTooltip>
            <UiSwitch
              :model-value="account.isActive"
              :disabled="readonly || isToggling || isTemporaryDisabling"
              :title="account.isActive ? 'Disable' : 'Enable'"
              @pointerdown="startLongPress"
              @pointerup="finishLongPress"
              @pointerleave="finishLongPress"
              @pointercancel="finishLongPress"
              @click.capture="toggleClick"
              @update:model-value="toggleActive"
            />
          </div>
        </div>
      </UiCardContent>
      <UiCardContent v-else class="flex flex-1 flex-col pt-0" aria-hidden="true">
        <div class="min-h-[26rem]" />
      </UiCardContent>
    </UiCard>

    <UiDialog v-model:open="dialogOpen" :ui="{ content: 'sm:max-w-md' }">
      <template #content>
        <div class="space-y-1.5 pr-6">
          <h2 class="text-lg font-semibold">Disable Temporarily</h2>
          <p class="text-sm text-muted-foreground">Choose how long "{{ account.name }}" should stay off.</p>
        </div>

        <div class="grid gap-3 sm:grid-cols-[1fr_auto]">
          <label class="grid gap-1 text-sm font-medium">
            Duration
            <input v-model.number="temporaryOffAmount" type="number" min="1" step="1" class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" @keydown.enter.prevent="disableTemporarily">
          </label>
          <label class="grid gap-1 text-sm font-medium">
            Unit
            <select v-model="temporaryOffUnit" class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <option v-for="unit in TEMPORARY_OFF_UNITS" :key="unit.value" :value="unit.value">{{ unit.label }}</option>
            </select>
          </label>
        </div>

        <p class="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">This account will turn back on {{ temporaryOffPreview }}.</p>
        <p v-if="temporaryOffError" class="text-sm text-red-500">{{ temporaryOffError }}</p>
        <div class="flex justify-end gap-2">
          <UiButton variant="outline" :disabled="isTemporaryDisabling" @click="dialogOpen = false">Cancel</UiButton>
          <UiButton :disabled="isTemporaryDisabling" @click="disableTemporarily">{{ isTemporaryDisabling ? 'Disabling...' : 'Disable' }}</UiButton>
        </div>
      </template>
    </UiDialog>

    <UiDialog v-model:open="editDialogOpen" :ui="{ content: 'sm:max-w-md' }">
      <template #content>
        <label class="grid gap-1 text-sm font-medium"><span>Name <span class="text-destructive">*</span></span><input v-model="editName" class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" @keydown.enter.prevent="renameAccount"></label>
        <div class="flex justify-end gap-2"><UiButton variant="outline" @click="editDialogOpen = false">Cancel</UiButton><UiButton :disabled="savingName" @click="renameAccount">{{ savingName ? 'Saving...' : 'Save' }}</UiButton></div>
      </template>
    </UiDialog>

    <UiDialog v-model:open="deleteDialogOpen" :ui="{ content: 'sm:max-w-md' }">
      <template #content>
        <div class="space-y-1.5 pr-6"><h2 class="text-lg font-semibold">Delete Account</h2><p class="text-sm text-muted-foreground">Delete <strong class="font-semibold text-foreground">{{ account.name }}</strong> &mdash; this cannot be undone.</p></div>
        <div class="flex justify-end gap-2"><UiButton variant="outline" @click="deleteDialogOpen = false">Cancel</UiButton><UiButton variant="destructive" :disabled="deleting" @click="deleteAccount">{{ deleting ? 'Deleting...' : 'Delete' }}</UiButton></div>
      </template>
    </UiDialog>

    <UiDialog v-model:open="errorDialogOpen" :ui="{ content: 'sm:max-w-xl' }" :show-close="false">
      <template #content>
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-1">
            <UiTooltip text="Copy all">
              <UiButton type="button" variant="outline" size="icon-sm" aria-label="Copy all errors" @click="copyErrors">
                <UiIcon :name="copiedAllErrors ? 'i-lucide-check' : 'i-lucide-clipboard-list'" class="size-4" />
              </UiButton>
            </UiTooltip>
            <UiTooltip text="Copy">
              <UiButton type="button" variant="outline" size="icon-sm" aria-label="Copy error details" @click="copyDetails">
                <UiIcon :name="copiedErrorDetails ? 'i-lucide-check' : 'i-lucide-copy'" class="size-4" />
              </UiButton>
            </UiTooltip>
            <UiTooltip text="Playground">
              <NuxtLink :to="errorPlaygroundRoute">
                <UiButton type="button" variant="outline" size="icon-sm" aria-label="Open in Playground">
                  <UiIcon name="i-lucide-flask-conical" class="size-4" />
                </UiButton>
              </NuxtLink>
            </UiTooltip>
            <UiTooltip text="Resolve">
              <UiButton type="button" variant="outline" size="icon-sm" aria-label="Resolve errors" :disabled="resolvingErrors" @click="resolveErrors">
                <UiIcon name="i-lucide-check-circle" class="size-4 text-green-600" />
              </UiButton>
            </UiTooltip>
          </div>
          <UiTooltip text="Close">
            <UiButton type="button" variant="ghost" size="icon-sm" aria-label="Close error details" class="shrink-0" @click="errorDialogOpen = false">
              <UiIcon name="i-lucide-x" class="size-4" />
            </UiButton>
          </UiTooltip>
        </div>

        <div class="max-h-[60vh] space-y-3 overflow-y-auto rounded-md border bg-muted/20 p-3">
          <div v-if="errorDetails && (errorDetails.provider || errorDetails.endpoint || errorDetails.model)" class="rounded-md border bg-background/70 p-2">
            <p v-if="errorDetails.provider" class="text-xs">
              <span class="text-muted-foreground">Provider:</span>
              <span class="font-mono">{{ errorDetails.provider }}</span>
            </p>
            <p v-if="errorDetails.endpoint" class="text-xs">
              <span class="text-muted-foreground">Endpoint:</span>
              <span class="font-mono">{{ errorDetails.endpoint }}</span>
            </p>
            <p v-if="errorDetails.model" class="text-xs">
              <span class="text-muted-foreground">Model:</span>
              <span class="font-mono">{{ errorDetails.model }}</span>
            </p>
          </div>

          <div v-if="errorDetails?.error">
            <p class="mb-1 text-xs text-muted-foreground">Error</p>
            <p class="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{{ errorDetails.error }}</p>
          </div>

          <div v-if="errorDetails?.parameters">
            <p class="mb-1 text-xs text-muted-foreground">Body Parameters</p>
            <p class="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{{ errorDetails.parameters }}</p>
          </div>

          <div v-if="errorDetails?.messageObjects && errorDetails.messageObjects.length > 0">
            <p class="mb-1 text-xs text-muted-foreground">Messages (object keys only)</p>
            <p class="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{{ errorDetails.messageObjects.join('\n') }}</p>
          </div>

          <p v-if="errorDetails && !errorDetails.error && !errorDetails.parameters && (!errorDetails.messageObjects || errorDetails.messageObjects.length === 0)" class="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
            {{ displayErrorMessage }}
          </p>

        </div>
      </template>
    </UiDialog>
  </div>
</template>
