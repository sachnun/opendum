<script setup lang="ts">
import { formatDistanceToNowStrict } from "date-fns";
import type { AccountQuotaInfo, ErrorHistoryResult, ProviderDetailData, QuotaGroupDisplay, QuotaProviderKey } from "../../lib/dashboard-api-types";

type Account = ProviderDetailData["accounts"][number];
type ErrorHistoryEntry = Extract<ErrorHistoryResult, { success: true }>["data"]["entries"][number];

type TemporaryOffUnit = "minutes" | "hours" | "days";

type QuotaSkeletonRow = {
  labelClass: string;
  metaClass: string;
  valueClass: string;
  barClass: string;
};

type ParsedErrorDetails = {
  error: string | null;
  provider: string | null;
  endpoint: string | null;
  model: string | null;
  parameters: string | null;
  messageObjects: string[] | null;
};

const QUOTA_PROVIDERS = new Set<string>(["antigravity", "copilot", "codex", "gemini_cli", "kiro", "openrouter"]);
const TEMPORARY_OFF_LONG_PRESS_MS = 600;
const TEMPORARY_OFF_UNITS: Array<{ value: TemporaryOffUnit; label: string; multiplier: number }> = [
  { value: "minutes", label: "Minutes", multiplier: 60 * 1000 },
  { value: "hours", label: "Hours", multiplier: 60 * 60 * 1000 },
  { value: "days", label: "Days", multiplier: 24 * 60 * 60 * 1000 },
];
const QUOTA_SKELETON_ROWS: Record<QuotaProviderKey, QuotaSkeletonRow[]> = {
  antigravity: [
    { labelClass: "w-24", metaClass: "w-10", valueClass: "w-8", barClass: "w-11/12" },
    { labelClass: "w-20", metaClass: "w-12", valueClass: "w-7", barClass: "w-3/5" },
    { labelClass: "w-24", metaClass: "w-9", valueClass: "w-8", barClass: "w-4/5" },
    { labelClass: "w-28", metaClass: "w-11", valueClass: "w-7", barClass: "w-2/3" },
    { labelClass: "w-20", metaClass: "w-10", valueClass: "w-8", barClass: "w-5/6" },
  ],
  copilot: [
    { labelClass: "w-36", metaClass: "w-12", valueClass: "w-16", barClass: "w-3/4" },
  ],
  codex: [
    { labelClass: "w-32", metaClass: "w-10", valueClass: "w-8", barClass: "w-4/5" },
    { labelClass: "w-36", metaClass: "w-12", valueClass: "w-8", barClass: "w-2/3" },
  ],
  gemini_cli: [
    { labelClass: "w-20", metaClass: "w-10", valueClass: "w-8", barClass: "w-5/6" },
    { labelClass: "w-28", metaClass: "w-12", valueClass: "w-8", barClass: "w-2/3" },
    { labelClass: "w-24", metaClass: "w-10", valueClass: "w-7", barClass: "w-3/4" },
  ],
  kiro: [
    { labelClass: "w-24", metaClass: "w-10", valueClass: "w-8", barClass: "w-4/5" },
    { labelClass: "w-28", metaClass: "w-12", valueClass: "w-8", barClass: "w-2/3" },
    { labelClass: "w-24", metaClass: "w-9", valueClass: "w-7", barClass: "w-5/6" },
    { labelClass: "w-16", metaClass: "w-10", valueClass: "w-8", barClass: "w-3/5" },
    { labelClass: "w-14", metaClass: "w-11", valueClass: "w-7", barClass: "w-1/2" },
    { labelClass: "w-20", metaClass: "w-10", valueClass: "w-8", barClass: "w-3/4" },
    { labelClass: "w-20", metaClass: "w-12", valueClass: "w-7", barClass: "w-2/3" },
  ],
  openrouter: [
    { labelClass: "w-24", metaClass: "w-0", valueClass: "w-20", barClass: "w-4/5" },
    { labelClass: "w-20", metaClass: "w-10", valueClass: "w-16", barClass: "w-3/5" },
  ],
};

const props = defineProps<{
  account: Account;
  showTier?: boolean;
  supportedModels?: string[];
  disabledModels?: string[];
  quotaInfo?: AccountQuotaInfo | null;
  quotaError?: string | null;
  isQuotaLoading?: boolean;
}>();

const emit = defineEmits<{
  changed: [];
  refreshQuota: [accountId: string];
}>();

const dashboardApi = useDashboardApi();
const isToggling = ref(false);
const isSubtitleVisible = ref(false);
const editDialogOpen = ref(false);
const deleteDialogOpen = ref(false);
const errorDialogOpen = ref(false);
const temporaryOffDialogOpen = ref(false);
const editName = ref(props.account.name);
const temporaryOffAmount = ref(30);
const temporaryOffUnit = ref<TemporaryOffUnit>("minutes");
const temporaryOffError = ref("");
const savingName = ref(false);
const deleting = ref(false);
const isTemporaryDisabling = ref(false);
const resolvingErrors = ref(false);
const copiedErrorDetails = ref(false);
const copiedAllErrors = ref(false);
const copiedErrorPreview = ref(false);
const copiedHistoryEntryId = ref<string | null>(null);
const isHistoryLoading = ref(false);
const historyError = ref<string | null>(null);
const historyEntries = ref<ErrorHistoryEntry[] | null>(null);
const cardRoot = ref<HTMLElement | null>(null);
let historyRequestId = 0;
let temporaryOffLongPressTimer: ReturnType<typeof setTimeout> | null = null;
let suppressNextToggle = false;

watch(
  () => props.account.name,
  (value) => {
    editName.value = value;
  }
);

watch(
  () => props.account.id,
  () => {
    historyRequestId += 1;
    historyEntries.value = null;
    historyError.value = null;
    isHistoryLoading.value = false;
  }
);

watch(errorDialogOpen, (open) => {
  if (!open || historyEntries.value !== null) return;

  isHistoryLoading.value = true;
  historyError.value = null;
  loadErrorHistory();
});

watch(temporaryOffDialogOpen, (open) => {
  if (!open) return;

  temporaryOffAmount.value = 30;
  temporaryOffUnit.value = "minutes";
  temporaryOffError.value = "";
});

function parseStoredErrorMessage(rawMessage: string): ParsedErrorDetails {
  const sections: Record<"error" | "provider" | "endpoint" | "model" | "parameters" | "messages", string[]> = {
    error: [],
    provider: [],
    endpoint: [],
    model: [],
    parameters: [],
    messages: [],
  };

  const labels: Array<{ key: keyof typeof sections; prefix: string }> = [
    { key: "error", prefix: "Error:" },
    { key: "provider", prefix: "Provider:" },
    { key: "endpoint", prefix: "Endpoint:" },
    { key: "model", prefix: "Model:" },
    { key: "parameters", prefix: "Parameters:" },
    { key: "messages", prefix: "Messages (object keys only):" },
  ];

  let currentKey: keyof typeof sections | null = null;

  for (const line of rawMessage.split("\n")) {
    const matchedLabel = labels.find((label) => line.startsWith(label.prefix));
    if (matchedLabel) {
      currentKey = matchedLabel.key;
      const initialValue = line.slice(matchedLabel.prefix.length).trimStart();
      if (initialValue) sections[currentKey].push(initialValue);
      continue;
    }

    if (currentKey) sections[currentKey].push(line);
  }

  const parsedMessageObjects = (() => {
    const rawMessages = sections.messages.join("\n").trim();
    if (!rawMessages) return null;

    try {
      const parsed = JSON.parse(rawMessages) as Array<{
        index?: number;
        keys?: unknown;
        type?: unknown;
      }>;

      if (!Array.isArray(parsed)) return null;

      return parsed.map((entry) => {
        if (typeof entry.index !== "number") return null;
        if (Array.isArray(entry.keys)) {
          const normalizedKeys = entry.keys.filter((value): value is string => typeof value === "string");
          return `#${entry.index}: ${normalizedKeys.length > 0 ? normalizedKeys.join(", ") : "(no keys)"}`;
        }

        if (typeof entry.type === "string") return `#${entry.index}: (${entry.type})`;

        return `#${entry.index}: (unknown)`;
      }).filter((entry): entry is string => entry !== null);
    } catch {
      return rawMessages
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    }
  })();

  return {
    error: sections.error.join("\n").trim() || null,
    provider: sections.provider.join("\n").trim() || null,
    endpoint: sections.endpoint.join("\n").trim() || null,
    model: sections.model.join("\n").trim() || null,
    parameters: sections.parameters.join("\n").trim() || null,
    messageObjects: parsedMessageObjects,
  };
}

function formatDuration(duration: number | null): string {
  if (duration === null) return "-";
  if (duration >= 1000) return `${(duration / 1000).toFixed(2)}s`;
  return `${duration}ms`;
}

function formatRelativeTime(value: string | Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  const relative = formatDistanceToNowStrict(date, { addSuffix: true });
  return relative === "0 seconds ago" ? "just now" : relative;
}

function formatHourLabel(time: string): string {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? time.slice(11, 16) : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatTierLabel(tier: string): string {
  const normalized = tier.trim().toLowerCase();

  switch (normalized) {
    case "free":
      return "Free";
    case "plus":
      return "Plus";
    case "pro":
      return "Pro";
    case "team":
      return "Team";
    case "go":
      return "Go";
    case "business":
      return "Business";
    case "enterprise":
      return "Enterprise";
    case "edu":
    case "education":
      return "Edu";
    case "paid":
    case "standard-tier":
      return "Paid";
    default:
      return normalized
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
        .join(" ");
  }
}

function isPaidTierValue(tier: string): boolean {
  return ["paid", "standard-tier", "plus", "pro", "team", "go", "business", "enterprise", "edu", "education"].includes(tier.trim().toLowerCase());
}

function maskSensitiveText(value: string): string {
  return value.replace(/[^\s@._-]/g, "•");
}

function getAccountHeader(account: Account): { title: string; subtitle: string | null } {
  const rawName = account.name.trim();
  const rawEmail = account.email?.trim() ?? "";

  if (!rawEmail) return { title: rawName, subtitle: null };

  const normalizedEmail = rawEmail.toLowerCase();
  let title = rawName;
  const trailingEmailMatch = title.match(/\(([^)]+)\)\s*$/);
  if (trailingEmailMatch?.[1]?.trim().toLowerCase() === normalizedEmail) {
    title = title.replace(/\([^)]+\)\s*$/, "").trim();
  }

  if (!title) title = rawEmail;
  if (title.toLowerCase().includes(normalizedEmail)) return { title, subtitle: null };
  return { title, subtitle: rawEmail };
}

const accountHeader = computed(() => getAccountHeader(props.account));
const accountTitle = computed(() => accountHeader.value.title || "Provider account");
const subtitle = computed(() => {
  return accountHeader.value.subtitle;
});
const subtitleDisplay = computed(() => (subtitle.value ? (isSubtitleVisible.value ? subtitle.value : maskSensitiveText(subtitle.value)) : null));
const dailyValues = computed(() => props.account.stats.dailyRequests.map((point) => point.count));
const durationValues = computed(() => props.account.stats.durationLast24Hours.map((point) => point.avgDuration ?? 0));
const durationLabelPoints = computed(() => [props.account.stats.durationLast24Hours[0], props.account.stats.durationLast24Hours[Math.floor(props.account.stats.durationLast24Hours.length / 2)], props.account.stats.durationLast24Hours[props.account.stats.durationLast24Hours.length - 1]].filter(Boolean) as Array<{ time: string; avgDuration: number | null }>);
const peakRequests = computed(() => Math.max(...dailyValues.value, 0));
const effectiveTier = computed(() => {
  const quotaTier = props.quotaInfo?.tier?.trim();
  if (props.account.provider === "codex" && quotaTier && quotaTier.toLowerCase() !== "unknown") return quotaTier;
  return props.account.tier;
});
const normalizedTier = computed(() => effectiveTier.value?.trim().toLowerCase() || "free");
const showTierBadge = computed(() => props.showTier && normalizedTier.value !== "unknown" && normalizedTier.value !== "guest");
const supportsQuotaMonitor = computed(() => QUOTA_PROVIDERS.has(props.account.provider));
const quotaSkeletonRows = computed(() => QUOTA_SKELETON_ROWS[props.account.provider as QuotaProviderKey] ?? []);
const usageChartColor = computed(() => props.account.isActive ? "var(--chart-1)" : "var(--muted-foreground)");
const usageChartColorAlt = computed(() => props.account.isActive ? "var(--chart-2)" : "var(--muted-foreground)");
const activeDisabledUntil = computed(() => {
  if (!props.account.disabledUntil) return null;

  const disabledUntil = new Date(props.account.disabledUntil);
  if (Number.isNaN(disabledUntil.getTime()) || disabledUntil <= new Date()) return null;
  return disabledUntil;
});
const accountStatusLabel = computed(() => {
  if (activeDisabledUntil.value) return `Cooldown ${formatRelativeTime(activeDisabledUntil.value).replace(/^in\s+/, "")}`;
  return props.account.isActive ? "On" : "Off";
});
const accountStatusTitle = computed(() => activeDisabledUntil.value ? `Temporarily disabled until ${activeDisabledUntil.value.toLocaleString()}` : undefined);
const temporaryOffPreview = computed(() => {
  const until = getTemporaryOffUntil();
  if (!until) return "Select a valid future duration.";
  return `${formatRelativeTime(until)} (${formatDateTime(until)})`;
});
const hasSuccessAfterLastError = computed(() => {
  if (!props.account.lastErrorAt) return false;
  const errorMs = new Date(props.account.lastErrorAt).getTime();
  const recoveredMs = Math.max(new Date(props.account.lastSuccessAt ?? 0).getTime() || 0, new Date(props.account.lastRecoveredByRotationAt ?? 0).getTime() || 0, new Date(props.account.lastUsedAt ?? 0).getTime() || 0);
  return recoveredMs > errorMs;
});
const errorToneClass = computed(() => {
  if (!props.account.lastErrorAt) return "text-muted-foreground";
  const errorMs = new Date(props.account.lastErrorAt).getTime();
  if (hasSuccessAfterLastError.value && Date.now() - errorMs > 3 * 60 * 60 * 1000) return "text-foreground";
  return hasSuccessAfterLastError.value ? "text-amber-400" : "text-red-500";
});
const currentErrorMessage = computed(() => props.account.lastErrorMessage ?? "");
const errorPreview = computed(() => (currentErrorMessage.value.length > 150 ? `${currentErrorMessage.value.slice(0, 150)}...` : currentErrorMessage.value));
const errorDetails = computed(() => (currentErrorMessage.value ? parseStoredErrorMessage(currentErrorMessage.value) : null));
const errorDialogDescription = computed(() => {
  return `${props.account.lastErrorCode ? `HTTP ${props.account.lastErrorCode}` : "No status code"}${props.account.lastErrorAt ? ` - ${formatRelativeTime(props.account.lastErrorAt)}` : ""}`;
});

function quotaPercentRemaining(group: QuotaGroupDisplay): number {
  return Math.max(0, Math.min(100, Math.round(group.remainingFraction * 100)));
}

function quotaResetTitle(group: QuotaGroupDisplay): string | undefined {
  if (!group.resetTimeIso) return undefined;
  const resetDate = new Date(group.resetTimeIso);
  return Number.isNaN(resetDate.getTime()) ? undefined : resetDate.toLocaleString();
}

function quotaBarColor(group: QuotaGroupDisplay): string {
  if (!props.account.isActive) return "bg-muted-foreground/50";

  const percentRemaining = quotaPercentRemaining(group);
  if (percentRemaining <= 10) return "bg-red-500";
  if (percentRemaining <= 25) return "bg-orange-500";
  if (percentRemaining <= 50) return "bg-yellow-500";
  return "bg-green-500";
}

function quotaTextColor(group: QuotaGroupDisplay): string {
  if (!props.account.isActive) return "text-muted-foreground";

  const percentRemaining = quotaPercentRemaining(group);
  if (percentRemaining <= 10) return "text-red-400";
  if (percentRemaining <= 25) return "text-orange-400";
  if (percentRemaining <= 50) return "text-yellow-400";
  return "text-green-400";
}

function formatDateTime(value: Date): string {
  return value.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function getTemporaryOffUntil(): Date | null {
  const amount = Number(temporaryOffAmount.value);
  if (!Number.isFinite(amount) || amount < 1) return null;

  const unit = TEMPORARY_OFF_UNITS.find((entry) => entry.value === temporaryOffUnit.value);
  if (!unit) return null;

  return new Date(Date.now() + Math.floor(amount) * unit.multiplier);
}

function clearTemporaryOffLongPress() {
  if (!temporaryOffLongPressTimer) return;

  clearTimeout(temporaryOffLongPressTimer);
  temporaryOffLongPressTimer = null;
}

function startTemporaryOffLongPress(event: PointerEvent) {
  if (!props.account.isActive || isToggling.value || isTemporaryDisabling.value) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;

  clearTemporaryOffLongPress();
  temporaryOffLongPressTimer = setTimeout(() => {
    suppressNextToggle = true;
    temporaryOffDialogOpen.value = true;
    clearTemporaryOffLongPress();
  }, TEMPORARY_OFF_LONG_PRESS_MS);
}

function finishTemporaryOffLongPress() {
  clearTemporaryOffLongPress();
}

function handleTemporaryOffToggleClick(event: Event) {
  if (!suppressNextToggle) return;

  event.preventDefault();
  event.stopPropagation();
  setTimeout(() => {
    suppressNextToggle = false;
  }, 0);
}

function refreshQuota() {
  emit("refreshQuota", props.account.id);
}

onBeforeUnmount(() => {
  clearTemporaryOffLongPress();
});

async function toggleActive() {
  if (suppressNextToggle) {
    suppressNextToggle = false;
    return;
  }

  isToggling.value = true;
  try {
    const result = await dashboardApi.accounts.update({ id: props.account.id, isActive: !props.account.isActive });
    if (!result.success) throw new Error(result.error);
    emit("changed");
  } finally {
    isToggling.value = false;
  }
}

async function disableTemporarily() {
  const disabledUntil = getTemporaryOffUntil();
  if (!disabledUntil) {
    temporaryOffError.value = "Please choose at least 1 minute, hour, or day.";
    return;
  }

  isTemporaryDisabling.value = true;
  temporaryOffError.value = "";
  try {
    const result = await dashboardApi.accounts.update({ id: props.account.id, disabledUntil: disabledUntil.toISOString() });
    if (!result.success) throw new Error(result.error);
    temporaryOffDialogOpen.value = false;
    emit("changed");
  } catch (error) {
    temporaryOffError.value = error instanceof Error ? error.message : "Failed to disable account temporarily";
  } finally {
    isTemporaryDisabling.value = false;
  }
}

async function renameAccount() {
  savingName.value = true;
  try {
    const result = await dashboardApi.accounts.update({ id: props.account.id, name: editName.value });
    if (!result.success) throw new Error(result.error);
    editDialogOpen.value = false;
    emit("changed");
  } finally {
    savingName.value = false;
  }
}

async function deleteAccount() {
  deleting.value = true;
  try {
    const result = await dashboardApi.accounts.delete({ id: props.account.id });
    if (!result.success) throw new Error(result.error);
    deleteDialogOpen.value = false;
    emit("changed");
  } finally {
    deleting.value = false;
  }
}

async function resolveErrors() {
  resolvingErrors.value = true;
  try {
    const result = await dashboardApi.accounts.resolveErrors({ accountId: props.account.id });
    if (!result.success) throw new Error(result.error);
    errorDialogOpen.value = false;
    emit("changed");
  } finally {
    resolvingErrors.value = false;
  }
}

async function loadErrorHistory() {
  const requestId = ++historyRequestId;

  try {
    const result = await dashboardApi.accounts.errorHistory({ accountId: props.account.id });
    if (requestId !== historyRequestId) return;

    if (!result.success) {
      historyError.value = result.error;
      historyEntries.value = [];
      return;
    }

    historyEntries.value = result.data.entries;
  } catch {
    if (requestId !== historyRequestId) return;
    historyError.value = "Failed to load error history";
    historyEntries.value = [];
  } finally {
    if (requestId === historyRequestId) isHistoryLoading.value = false;
  }
}

async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function resetFlag(flag: { value: boolean }) {
  setTimeout(() => {
    flag.value = false;
  }, 1500);
}

async function copyErrorPreview(event: Event) {
  event.stopPropagation();
  event.preventDefault();

  if (!(await copyToClipboard(currentErrorMessage.value))) return;
  copiedErrorPreview.value = true;
  resetFlag(copiedErrorPreview);
}

async function copyErrorDetails() {
  if (!(await copyToClipboard(currentErrorMessage.value))) return;
  copiedErrorDetails.value = true;
  resetFlag(copiedErrorDetails);
}

async function copyAllErrors() {
  const parts: string[] = [`[Current Error]\n${currentErrorMessage.value}`];

  if (historyEntries.value && historyEntries.value.length > 0) {
    for (const entry of historyEntries.value) {
      parts.push(`[${entry.errorCode ? `HTTP ${entry.errorCode}` : "No code"} - ${new Date(entry.createdAt).toLocaleString()}]\n${entry.errorMessage}`);
    }
  }

  if (!(await copyToClipboard(parts.join("\n\n---\n\n")))) return;
  copiedAllErrors.value = true;
  resetFlag(copiedAllErrors);
}

async function copyHistoryError(entry: ErrorHistoryEntry, event: Event) {
  event.stopPropagation();

  if (!(await copyToClipboard(entry.errorMessage))) return;
  copiedHistoryEntryId.value = entry.id;
  setTimeout(() => {
    if (copiedHistoryEntryId.value === entry.id) copiedHistoryEntryId.value = null;
  }, 1500);
}

function historyEntryRelativeTime(entry: ErrorHistoryEntry): string {
  const createdAt = new Date(entry.createdAt);
  return Number.isNaN(createdAt.getTime()) ? "Unknown time" : formatRelativeTime(createdAt);
}

function historyEntryPreview(errorMessage: string): string {
  return errorMessage.length > 120 ? `${errorMessage.slice(0, 120)}...` : errorMessage;
}
</script>

<template>
  <div ref="cardRoot" class="h-full">
    <UiCard class="flex h-full flex-col bg-card" :class="!account.isActive ? 'opacity-65' : ''">
      <UiCardHeader class="pb-2">
        <div class="flex min-w-0 items-center justify-between gap-2">
          <UiCardTitle class="min-w-0 truncate text-lg">{{ accountTitle }}</UiCardTitle>
          <div class="flex flex-wrap justify-end gap-1">
            <UiBadge v-if="showTierBadge" variant="outline" :class="isPaidTierValue(normalizedTier) ? 'border-green-500 text-green-600' : ''">
              {{ formatTierLabel(normalizedTier) }}
            </UiBadge>
            <UiBadge v-if="account.status === 'failed'" variant="destructive" class="gap-1">
              <UiIcon name="i-lucide-alert-circle" class="size-3" />
              Failed
            </UiBadge>
            <UiBadge v-else-if="account.status === 'degraded'" variant="outline" class="border-yellow-500 text-yellow-600 gap-1">
              <UiIcon name="i-lucide-triangle-alert" class="size-3" />
              Degraded ({{ account.consecutiveErrors }})
            </UiBadge>
            <UiBadge v-else-if="account.status === 'half_open'" variant="outline" class="border-yellow-500 text-yellow-600 gap-1">
              <UiIcon name="i-lucide-activity" class="size-3" />
              Recovering
            </UiBadge>
          </div>
        </div>
        <div v-if="subtitleDisplay" :class="['grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-1', isSubtitleVisible ? 'items-start' : 'w-full items-center overflow-hidden']">
          <p :class="['min-w-0 font-mono text-sm text-muted-foreground', isSubtitleVisible ? 'break-all whitespace-normal' : 'truncate whitespace-nowrap']">{{ subtitleDisplay }}</p>
          <UiButton
            variant="ghost"
            size="icon-sm"
            class="h-7 w-7 shrink-0 self-start text-muted-foreground hover:text-foreground"
            :aria-label="isSubtitleVisible ? `Hide account email for ${accountTitle}` : `Show account email for ${accountTitle}`"
            :title="isSubtitleVisible ? 'Hide email' : 'Show email'"
            @click="isSubtitleVisible = !isSubtitleVisible"
          >
            <UiIcon :name="isSubtitleVisible ? 'i-lucide-eye-off' : 'i-lucide-eye'" class="size-3.5" />
          </UiButton>
        </div>
      </UiCardHeader>
      <UiCardContent class="flex flex-1 flex-col">
        <div class="flex-1 space-y-2 text-sm">
          <div class="mb-3 rounded-md border border-border/70 bg-muted/20 p-2.5">
            <div class="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
              <span class="inline-flex items-center gap-1"><UiIcon name="i-lucide-bar-chart-3" class="size-3" />30d</span>
              <span class="tabular-nums">{{ peakRequests.toLocaleString() }} peak</span>
            </div>
            <div class="mb-2 grid grid-cols-3 gap-1.5">
              <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                <p class="truncate text-[10px] text-muted-foreground">Requests</p>
                <p class="truncate text-sm font-semibold tabular-nums text-foreground">{{ account.stats.totalRequests.toLocaleString() }}</p>
              </div>
              <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                <p class="truncate text-[10px] text-muted-foreground">Success</p>
                <p class="truncate text-sm font-semibold tabular-nums text-foreground">{{ account.stats.successRate === null ? '-' : `${account.stats.successRate}%` }}</p>
              </div>
              <div class="rounded border border-border/60 bg-background/70 px-2 py-1.5">
                <p class="truncate text-[10px] text-muted-foreground">Latency</p>
                <p class="truncate text-sm font-semibold tabular-nums text-foreground">{{ formatDuration(account.stats.avgDurationLastDay) }}</p>
              </div>
            </div>
            <div class="mb-2 rounded border border-border/60 bg-background/70 px-2 py-1.5">
              <UsageSparkline :values="durationValues" :color="usageChartColorAlt" :aria-label="`Average duration trend for ${accountTitle} over last 24 hours`" class="h-6" :height="24" />
              <div class="mt-0.5 grid grid-cols-3 text-[9px] text-muted-foreground">
                <span v-for="point in durationLabelPoints" :key="point.time" class="truncate text-center">{{ formatHourLabel(point.time) }}</span>
              </div>
            </div>
            <UsageSparkline :values="dailyValues" :color="usageChartColor" :aria-label="`Requests trend for ${accountTitle}`" />
          </div>

          <div class="flex justify-between"><span class="text-muted-foreground">Last used</span><span class="font-medium">{{ account.lastUsedAt ? formatRelativeTime(account.lastUsedAt) : 'Never' }}</span></div>
          <div class="flex justify-between"><span class="text-muted-foreground">Last Error</span><span :class="['font-medium', account.lastErrorAt ? errorToneClass : 'text-muted-foreground']">{{ account.lastErrorAt ? formatRelativeTime(account.lastErrorAt) : '-' }}</span></div>

          <div class="min-h-14 border-t">
            <button v-if="account.lastErrorMessage" type="button" class="w-full min-h-[7rem] cursor-pointer rounded-sm pt-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="errorDialogOpen = true">
              <div class="flex items-center justify-between gap-1">
                <span class="text-xs text-muted-foreground">Last Error Message:</span>
                <button
                  type="button"
                  class="shrink-0 cursor-pointer rounded p-0.5 transition-colors hover:bg-muted"
                  aria-label="Copy last error message"
                  title="Copy last error message"
                  @click="copyErrorPreview"
                >
                  <UiIcon v-if="copiedErrorPreview" name="i-lucide-check" class="size-3 text-green-600" />
                  <UiIcon v-else name="i-lucide-copy" class="size-3 text-muted-foreground" />
                </button>
              </div>
              <div class="mt-1 flex min-h-16 items-center">
                <span :class="['line-clamp-4 break-all text-xs', errorToneClass]">{{ account.lastErrorCode ? `[${account.lastErrorCode}] ` : '' }}{{ errorPreview }}</span>
              </div>
              <span class="mt-1 block text-[10px] text-muted-foreground/80">Click for details</span>
            </button>
            <div v-else class="w-full min-h-[7rem] rounded-sm pt-2 text-left">
              <div class="flex items-center justify-between gap-1">
                <span class="text-xs text-muted-foreground">Last Error Message:</span>
              </div>
              <div class="mt-1 flex min-h-16 items-center justify-center text-center text-xs text-muted-foreground">No data</div>
              <span class="invisible mt-1 block text-[10px] text-muted-foreground/80">Click for details</span>
            </div>
          </div>

          <div v-if="supportsQuotaMonitor" class="mt-3 space-y-2 border-t pt-3">
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-medium text-muted-foreground">Quota</span>
              <UiButton
                type="button"
                variant="ghost"
                size="icon-sm"
                class="h-6 w-6"
                :disabled="isQuotaLoading"
                :aria-label="`Refresh quota for ${accountTitle}`"
                title="Refresh quota"
                @click="refreshQuota"
              >
                <UiIcon name="i-lucide-refresh-cw" :class="['size-3.5', isQuotaLoading ? 'animate-spin' : '']" />
              </UiButton>
            </div>

            <div v-if="!quotaInfo && !quotaError" class="space-y-2" aria-hidden="true">
              <div v-for="(row, index) in quotaSkeletonRows" :key="index" class="space-y-1">
                <div class="flex items-center justify-between gap-2">
                  <UiSkeleton :class="['h-3', row.labelClass]" />
                  <span class="flex items-center gap-2">
                    <UiSkeleton v-if="row.metaClass !== 'w-0'" :class="['h-2.5', row.metaClass]" />
                    <UiSkeleton :class="['h-3', row.valueClass]" />
                  </span>
                </div>
                <div class="h-1.5 overflow-hidden rounded-full bg-muted">
                  <UiSkeleton :class="['h-full rounded-full', row.barClass]" />
                </div>
              </div>
            </div>

            <template v-else>
              <p v-if="quotaError" class="text-xs text-red-500">{{ quotaError }}</p>
              <div v-else-if="quotaInfo.status === 'success' && quotaInfo.groups.length > 0" class="space-y-2">
                <div v-for="group in quotaInfo.groups" :key="group.name" class="space-y-1">
                  <div class="flex items-center justify-between gap-2 text-xs">
                    <span class="min-w-0 truncate text-muted-foreground">{{ group.displayName }}</span>
                    <span class="flex items-center gap-2">
                      <span v-if="group.resetInHuman" class="text-[10px] text-muted-foreground" :title="quotaResetTitle(group)">
                        {{ group.resetInHuman }}
                      </span>
                      <span :class="['font-mono', quotaTextColor(group)]">{{ quotaPercentRemaining(group) }}%</span>
                    </span>
                  </div>
                  <div class="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div class="h-full transition-all duration-300" :class="quotaBarColor(group)" :style="{ width: `${quotaPercentRemaining(group)}%` }" />
                  </div>
                </div>
              </div>
              <p v-else class="text-xs text-red-500">{{ quotaInfo.error ?? 'Failed to fetch quota data.' }}</p>
            </template>
          </div>

          <AccountModelAccess v-if="supportedModels?.length" :account-id="account.id" :supported-models="supportedModels" :initial-disabled-models="disabledModels ?? []" />
        </div>
        <div class="mt-4 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <UiButton variant="outline" size="sm" @click="editDialogOpen = true"><UiIcon name="i-lucide-pencil" class="size-3" /></UiButton>
            <UiButton variant="outline" size="sm" @click="deleteDialogOpen = true"><UiIcon name="i-lucide-trash-2" class="size-3 text-destructive" /></UiButton>
            <NuxtLink v-if="account.isActive" :to="`/dashboard/playground?accountId=${account.id}`">
              <UiButton variant="outline" size="sm" title="Open in Playground"><UiIcon name="i-lucide-flask-conical" class="size-3" /></UiButton>
            </NuxtLink>
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            <span class="max-w-32 truncate text-[11px] text-muted-foreground" :title="accountStatusTitle">{{ accountStatusLabel }}</span>
            <UiSwitch
              :model-value="account.isActive"
              :disabled="isToggling || isTemporaryDisabling"
              :title="account.isActive ? 'Disable account. Hold to choose duration.' : 'Enable account'"
              @pointerdown="startTemporaryOffLongPress"
              @pointerup="finishTemporaryOffLongPress"
              @pointerleave="finishTemporaryOffLongPress"
              @pointercancel="finishTemporaryOffLongPress"
              @click.capture="handleTemporaryOffToggleClick"
              @update:model-value="toggleActive"
            />
          </div>
        </div>
      </UiCardContent>
    </UiCard>

    <UiDialog v-model:open="temporaryOffDialogOpen" :ui="{ content: 'sm:max-w-md' }">
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
          <UiButton variant="outline" :disabled="isTemporaryDisabling" @click="temporaryOffDialogOpen = false">Cancel</UiButton>
          <UiButton :disabled="isTemporaryDisabling" @click="disableTemporarily">{{ isTemporaryDisabling ? 'Disabling...' : 'Disable' }}</UiButton>
        </div>
      </template>
    </UiDialog>

    <UiDialog v-model:open="editDialogOpen" :ui="{ content: 'sm:max-w-md' }">
      <template #content>
        <label class="grid gap-1 text-sm font-medium">Name<input v-model="editName" class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" @keydown.enter.prevent="renameAccount"></label>
        <div class="flex justify-end gap-2"><UiButton variant="outline" @click="editDialogOpen = false">Cancel</UiButton><UiButton :disabled="savingName" @click="renameAccount">{{ savingName ? 'Saving...' : 'Save' }}</UiButton></div>
      </template>
    </UiDialog>

    <UiDialog v-model:open="deleteDialogOpen" :ui="{ content: 'sm:max-w-md' }">
      <template #content>
        <div class="space-y-1.5 pr-6"><h2 class="text-lg font-semibold">Delete Account</h2><p class="text-sm text-muted-foreground">Delete <strong class="font-semibold text-foreground">{{ account.name }}</strong> &mdash; this cannot be undone.</p></div>
        <div class="flex justify-end gap-2"><UiButton variant="outline" @click="deleteDialogOpen = false">Cancel</UiButton><UiButton variant="destructive" :disabled="deleting" @click="deleteAccount">{{ deleting ? 'Deleting...' : 'Delete' }}</UiButton></div>
      </template>
    </UiDialog>

    <UiDialog v-model:open="errorDialogOpen" :ui="{ content: 'sm:max-w-xl' }">
      <template #content>
        <div class="flex items-start justify-between gap-3 pr-6">
          <div>
            <h2 class="text-lg font-semibold">Provider Error Details</h2>
            <p class="text-sm text-muted-foreground">{{ errorDialogDescription }}</p>
          </div>
          <div class="flex items-center gap-1">
            <UiButton type="button" variant="outline" size="icon-sm" aria-label="Copy all errors" title="Copy all errors (current + history)" @click="copyAllErrors">
              <UiIcon :name="copiedAllErrors ? 'i-lucide-check' : 'i-lucide-clipboard-list'" class="size-4" />
            </UiButton>
            <UiButton type="button" variant="outline" size="icon-sm" aria-label="Copy error details" title="Copy error details" @click="copyErrorDetails">
              <UiIcon :name="copiedErrorDetails ? 'i-lucide-check' : 'i-lucide-copy'" class="size-4" />
            </UiButton>
            <UiButton type="button" variant="outline" size="icon-sm" aria-label="Resolve errors" title="Resolve — clear all errors and error history for this account" :disabled="resolvingErrors" @click="resolveErrors">
              <UiIcon name="i-lucide-check-circle" class="size-4 text-green-600" />
            </UiButton>
          </div>
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
            {{ currentErrorMessage }}
          </p>

          <div class="border-t pt-3">
            <p class="mb-2 text-xs text-muted-foreground">Recent Error History (up to 200)</p>

            <p v-if="isHistoryLoading" class="text-xs text-muted-foreground">Loading error history...</p>

            <p v-else-if="historyError" class="text-xs text-red-500">{{ historyError }}</p>

            <div v-else-if="historyEntries && historyEntries.length > 0" class="space-y-2">
              <details v-for="entry in historyEntries" :key="entry.id" class="rounded-md border bg-background/70 p-2">
                <summary class="cursor-pointer break-words text-xs text-foreground">
                  <span class="font-medium">{{ historyEntryRelativeTime(entry) }}</span>
                  <span class="mx-1 text-muted-foreground">-</span>
                  <span class="font-mono text-[11px] text-muted-foreground">HTTP {{ entry.errorCode }}</span>
                  <span class="mx-1 text-muted-foreground">-</span>
                  <span class="text-muted-foreground">{{ historyEntryPreview(entry.errorMessage) }}</span>
                </summary>
                <div class="mt-2 flex items-start gap-2">
                  <p class="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs text-foreground">{{ entry.errorMessage }}</p>
                  <UiButton type="button" variant="ghost" size="icon-sm" class="shrink-0" aria-label="Copy error message" title="Copy error message" @click="copyHistoryError(entry, $event)">
                    <UiIcon :name="copiedHistoryEntryId === entry.id ? 'i-lucide-check' : 'i-lucide-copy'" class="size-3.5" />
                  </UiButton>
                </div>
              </details>
            </div>

            <p v-else-if="historyEntries && historyEntries.length === 0" class="text-xs text-muted-foreground">No stored error history yet.</p>
          </div>
        </div>
      </template>
    </UiDialog>
  </div>
</template>
