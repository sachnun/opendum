<script setup lang="ts">
import { formatDistanceToNowStrict } from "date-fns";
import type { AccountQuotaInfo, ErrorHistoryResult, ProviderAccountUpdateData, ProviderDetailData, QuotaGroupDisplay, QuotaProviderKey } from "../../lib/dashboard-api-types";

type Account = ProviderDetailData["accounts"][number];
type ErrorHistoryEntry = Extract<ErrorHistoryResult, { success: true }>["data"]["entries"][number];
type ErrorPreviewEntry = {
  id: string;
  model: string | null;
  errorCode: number | null;
  errorMessage: string;
  createdAt: string | Date | null;
  isCurrent: boolean;
};

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

type ErrorStatusTag = {
  code: number;
  label: string;
};
type StatDeltaTone = "positive" | "negative" | "neutral";
type StatHitEffect = { text: string; tone: StatDeltaTone; version: number };
type StatMetric = { key: string; label: string; value: string; numericValue: number; formatDelta: (delta: number) => string; getTone?: (delta: number) => StatDeltaTone };
type DurationPoint = { time: string; avgDuration: number | null };

type ErrorPlaygroundEndpoint = "chat_completions" | "messages" | "responses";

const QUOTA_PROVIDERS = new Set<string>(["antigravity", "copilot", "codex", "gemini_cli", "kiro", "openrouter"]);
const TEMPORARY_OFF_LONG_PRESS_MS = 600;
const ERROR_PREVIEW_SWIPE_THRESHOLD_PX = 45;
const ERROR_PREVIEW_VISIBLE_COUNT = 9;
const ERROR_PREVIEW_CENTER_INDEX = 4;
const RECOVERED_ERROR_STALE_MS = 3 * 60 * 60 * 1000;
const TEMPORARY_OFF_UNITS: Array<{ value: TemporaryOffUnit; label: string; multiplier: number }> = [
  { value: "minutes", label: "Minutes", multiplier: 60 * 1000 },
  { value: "hours", label: "Hours", multiplier: 60 * 60 * 1000 },
  { value: "days", label: "Days", multiplier: 24 * 60 * 60 * 1000 },
];
const HTTP_STATUS_DESCRIPTIONS: Record<number, string> = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a Teapot",
  421: "Misdirected Request",
  422: "Unprocessable Content",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Rate Limit",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  510: "Not Extended",
  511: "Network Authentication Required",
};
const QUOTA_SKELETON_ROWS: Record<QuotaProviderKey, QuotaSkeletonRow[]> = {
  antigravity: [
    { labelClass: "w-14", metaClass: "w-10", valueClass: "w-8", barClass: "w-11/12" },
    { labelClass: "w-24", metaClass: "w-12", valueClass: "w-8", barClass: "w-4/5" },
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
  modelHealth?: ProviderDetailData["modelHealthByAccountId"][string];
  quotaInfo?: AccountQuotaInfo | null;
  quotaError?: string | null;
  highlight?: boolean;
  animateDeltas?: boolean;
  readonly?: boolean;
}>();

const emit = defineEmits<{
  renamed: [account: ProviderAccountUpdateData];
  "active-updated": [account: ProviderAccountUpdateData];
  "temporarily-disabled": [account: ProviderAccountUpdateData];
  deleted: [accountId: string];
  "errors-resolved": [accountId: string];
}>();

const dashboardApi = useDashboardApi();
const { auditRefreshVersion, auditUser, isAuditMode } = useDashboardAudit();
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
const historyError = ref<string | null>(null);
const historyEntries = ref<ErrorHistoryEntry[] | null>(null);
const statHitEffects = ref<Record<string, StatHitEffect>>({});
const previousStatValues = ref<Record<string, number> | null>(null);
const previousStatAnimationContextKey = ref<string | null>(null);
const pendingStatBaselineContextKey = ref<string | null>(null);
const activeErrorIndex = ref(0);
const cardRoot = ref<HTMLElement | null>(null);
let historyRequestId = 0;
let temporaryOffLongPressTimer: ReturnType<typeof setTimeout> | null = null;
let suppressNextToggle = false;
let errorPreviewDragStartX: number | null = null;
let suppressNextErrorPreviewClick = false;

watch(
  () => props.account.name,
  (value) => {
    editName.value = value;
  }
);

watch(temporaryOffDialogOpen, (open) => {
  if (!open) return;

  temporaryOffAmount.value = 30;
  temporaryOffUnit.value = "minutes";
  temporaryOffError.value = "";
});

function parseStoredErrorMessage(rawMessage: string, code: number | null | undefined): ParsedErrorDetails {
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
    error: stripStatusFromErrorMessage(sections.error.join("\n"), code) || null,
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

function compactNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return n.toLocaleString();
}

function formatSignedInteger(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  return `${sign} ${compactNumber(Math.abs(Math.round(delta)))}`;
}

function formatSignedDuration(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  return `${sign} ${formatDuration(Math.abs(Math.round(delta)))}`;
}

function formatSignedPercent(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  const value = Math.round(Math.abs(delta) * 10) / 10;
  return `${sign} ${value}%`;
}

function collectStatValues(items: StatMetric[]): Record<string, number> {
  const values: Record<string, number> = {};

  for (const item of items) {
    if (Number.isFinite(item.numericValue)) values[item.key] = item.numericValue;
  }

  return values;
}

function buildHourKeys(hours: number): string[] {
  const now = new Date();
  const currentHourUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));

  return Array.from({ length: hours }, (_, index) => {
    const date = new Date(currentHourUtc);
    date.setUTCHours(currentHourUtc.getUTCHours() - (hours - 1 - index));
    return date.toISOString();
  });
}

function buildDayKeys(days: number): string[] {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(todayUtc);
    date.setUTCDate(todayUtc.getUTCDate() - (days - 1 - index));
    return date.toISOString().split("T")[0] ?? "";
  });
}

function expandDailyPoints(points: Array<{ date: string; count: number }>) {
  const valuesByDate = new Map(points.map((point) => [point.date, point.count]));
  return buildDayKeys(30).map((date) => ({ date, count: valuesByDate.get(date) ?? 0 }));
}

function expandDurationPoints(points: Array<{ time: string; avgDuration: number }>): DurationPoint[] {
  const valuesByTime = new Map(points.map((point) => [point.time, point.avgDuration]));
  return buildHourKeys(24).map((time) => ({ time, avgDuration: valuesByTime.get(time) ?? null }));
}

function formatRelativeTime(value: string | Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  const relative = formatDistanceToNowStrict(date, { addSuffix: true });
  return relative === "0 seconds ago" ? "just now" : relative;
}

function toTimeMs(value: string | Date | null | undefined): number | null {
  if (!value) return null;

  const timeMs = new Date(value).getTime();
  return Number.isNaN(timeMs) ? null : timeMs;
}

function getHttpStatusDescription(code: number): string {
  return HTTP_STATUS_DESCRIPTIONS[code] ?? "HTTP Error";
}

function getErrorStatusTag(code: number | null | undefined): ErrorStatusTag | null {
  return code ? { code, label: getHttpStatusDescription(code) } : null;
}

function stripStatusFromErrorMessage(message: string, code: number | null | undefined): string {
  const trimmed = message.trimStart().replace(/^Error:\s*/i, "");
  if (!code) return trimmed;

  return trimmed
    .replace(new RegExp(`^\\[${code}\\]\\s*(?:error:\\s*)?`, "i"), "")
    .replace(new RegExp(`^HTTP\\s+${code}\\s*[:\\-]?\\s*(?:error:\\s*)?`, "i"), "")
    .replace(/^Error:\s*/i, "")
    .trimStart();
}

function getErrorMessageModel(message: string, code: number | null | undefined): string | null {
  return parseStoredErrorMessage(message, code).model?.trim() || null;
}

function normalizePlaygroundEndpoint(value: string | null | undefined): ErrorPlaygroundEndpoint | null {
  const normalized = value?.trim().replace(/^\/v1\//, "") ?? "";
  if (normalized === "chat/completions" || normalized === "chat_completions") return "chat_completions";
  if (normalized === "messages") return "messages";
  if (normalized === "responses") return "responses";
  return null;
}

function parseErrorParameters(value: string | null | undefined): Record<string, unknown> | null {
  if (!value?.trim()) return null;

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function addPlaygroundParam(query: Record<string, string>, params: Record<string, unknown>, targetKey: string, sourceKeys: string[] = []) {
  for (const key of [targetKey, ...sourceKeys]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      query[targetKey] = value.trim();
      return;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      query[targetKey] = String(value);
      return;
    }
    if (typeof value === "boolean") {
      query[targetKey] = String(value);
      return;
    }
  }
}

function addAdditionalPlaygroundParams(query: Record<string, string>, params: Record<string, unknown>) {
  const handledKeys = new Set([
    "stream",
    "temperature",
    "top_p",
    "max_tokens",
    "max_output_tokens",
    "max_completion_tokens",
    "presence_penalty",
    "frequency_penalty",
    "reasoning_effort",
  ]);
  const additionalParams = Object.fromEntries(Object.entries(params).filter(([key]) => !handledKeys.has(key)));
  if (Object.keys(additionalParams).length > 0) query.additional_parameters = JSON.stringify(additionalParams);
}

function formatHourLabel(time: string): string {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? time.slice(11, 16) : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isPreviousDayLabel(time: string): boolean {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

function isPaidTierValue(tier: string, provider?: string): boolean {
  const value = tier.trim().toLowerCase();
  if (provider === "antigravity") return ["paid", "standard-tier"].includes(value);
  if (provider === "kiro") return ["pro", "pro-plus", "pro+", "power"].includes(value);
  return ["paid", "standard-tier", "plus", "pro", "pro-plus", "pro+", "prolite", "power", "team", "go", "self_serve_business_usage_based", "business", "enterprise_cbp_usage_based", "enterprise", "edu", "education", "hc"].includes(value);
}

function isFreeTierValue(tier: string): boolean {
  return ["free", "free-tier", "legacy-tier"].includes(tier.trim().toLowerCase());
}

function formatTierBadgeLabel(tier: string, provider?: string): "Paid" | "Free" | "" {
  if (isPaidTierValue(tier, provider)) return "Paid";
  if (isFreeTierValue(tier)) return "Free";
  return "";
}

function maskSensitiveText(value: string): string {
  return value.replace(/\S/g, "•");
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
const dailyPoints = computed(() => expandDailyPoints(props.account.stats.dailyRequests));
const dailyValues = computed(() => dailyPoints.value.map((point) => point.count));
const durationPoints = computed(() => expandDurationPoints(props.account.stats.durationLast24Hours));
const durationValues = computed(() => durationPoints.value.map((point) => point.avgDuration ?? 0));
const durationLabelPoints = computed(() => {
  const points = durationPoints.value;
  const tickCount = Math.min(5, points.length);
  const indexes = Array.from(new Set(Array.from({ length: tickCount }, (_, index) => Math.round((index / (tickCount - 1 || 1)) * (points.length - 1)))));
  return indexes.map((index) => points[index]).filter(Boolean) as DurationPoint[];
});
const statMetrics = computed<StatMetric[]>(() => [
  { key: "totalRequests", label: "Requests", value: props.account.stats.totalRequests.toLocaleString(), numericValue: props.account.stats.totalRequests, formatDelta: formatSignedInteger },
  { key: "totalTokens", label: "Token", value: compactNumber(props.account.stats.totalTokens), numericValue: props.account.stats.totalTokens, formatDelta: formatSignedInteger },
  { key: "successRate", label: "Success", value: props.account.stats.successRate === null ? "-" : `${props.account.stats.successRate}%`, numericValue: props.account.stats.successRate ?? Number.NaN, formatDelta: formatSignedPercent },
  { key: "avgDuration", label: "Latency", value: formatDuration(props.account.stats.avgDurationLastDay), numericValue: props.account.stats.avgDurationLastDay ?? Number.NaN, formatDelta: formatSignedDuration, getTone: (delta) => delta > 0 ? "negative" : "positive" },
]);
const statAnimationContextKey = computed(() => {
  const userKey = isAuditMode.value ? `audit:${auditUser.value?.id ?? ""}` : "self";
  return `${props.account.id}:${userKey}:${auditRefreshVersion.value}`;
});
const usageStats = computed(() => statMetrics.value.map((stat) => ({ ...stat, hit: props.animateDeltas === false ? undefined : statHitEffects.value[stat.key] })));
const effectiveTier = computed(() => {
  const quotaTier = props.quotaInfo?.tier?.trim();
  if (["codex", "kiro"].includes(props.account.provider) && quotaTier && quotaTier.toLowerCase() !== "unknown") return quotaTier;
  return props.account.tier;
});
const normalizedTier = computed(() => effectiveTier.value?.trim().toLowerCase() || "");
const tierBadgeLabel = computed(() => formatTierBadgeLabel(normalizedTier.value, props.account.provider));
const showTierBadge = computed(() => props.showTier && tierBadgeLabel.value !== "");
const supportsQuotaMonitor = computed(() => QUOTA_PROVIDERS.has(props.account.provider));
const quotaSkeletonRows = computed(() => QUOTA_SKELETON_ROWS[props.account.provider as QuotaProviderKey] ?? QUOTA_SKELETON_ROWS.copilot);
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
function getRecoveredTimeMs(): number {
  return Math.max(toTimeMs(props.account.lastSuccessAt) ?? 0, toTimeMs(props.account.lastRecoveredByRotationAt) ?? 0, toTimeMs(props.account.lastUsedAt) ?? 0);
}

function getErrorToneClass(entry: ErrorPreviewEntry | null | undefined): string {
  const errorMs = toTimeMs(entry?.createdAt);
  if (!errorMs) return "text-muted-foreground";

  const recoveredMs = getRecoveredTimeMs();
  const hasRecoveredAfterError = recoveredMs > errorMs;

  const model = entry?.model?.trim() || (entry?.errorMessage ? getErrorMessageModel(entry.errorMessage, entry.errorCode) : null);
  if (model) {
    const health = props.modelHealth?.[model];
    const modelRecoveredMs = toTimeMs(health?.lastSuccessAt);
    const hasModelRecoveredAfterError = Boolean(modelRecoveredMs && modelRecoveredMs > errorMs);

    if (!hasModelRecoveredAfterError) return hasRecoveredAfterError ? "text-amber-400" : "text-red-500";
    if (health?.status === "active" && Date.now() - errorMs > RECOVERED_ERROR_STALE_MS) return "text-foreground";
    return "text-amber-400";
  }

  if (hasRecoveredAfterError && Date.now() - errorMs > RECOVERED_ERROR_STALE_MS) return "text-foreground";
  return hasRecoveredAfterError ? "text-amber-400" : "text-red-500";
}

const currentErrorMessage = computed(() => props.account.lastErrorMessage ?? "");
const currentHistoryEntry = computed(() => {
  const currentErrorAtMs = toTimeMs(props.account.lastErrorAt);

  return (historyEntries.value ?? []).find((entry) => {
    const entryCreatedAtMs = toTimeMs(entry.createdAt);
    const isSameError = entry.errorCode === props.account.lastErrorCode && entry.errorMessage === currentErrorMessage.value;
    if (!isSameError) return false;
    if (!currentErrorAtMs) return true;

    return !entryCreatedAtMs || Math.abs(entryCreatedAtMs - currentErrorAtMs) <= 1000;
  }) ?? null;
});
const currentErrorModel = computed(() => currentHistoryEntry.value?.model ?? getErrorMessageModel(currentErrorMessage.value, props.account.lastErrorCode));
const currentErrorPreviewEntry = computed<ErrorPreviewEntry>(() => ({
  id: "current",
  model: currentErrorModel.value,
  errorCode: props.account.lastErrorCode,
  errorMessage: currentErrorMessage.value,
  createdAt: props.account.lastErrorAt,
  isCurrent: true,
}));
const errorToneClass = computed(() => getErrorToneClass(currentErrorPreviewEntry.value));
const allErrorPreviewEntries = computed<ErrorPreviewEntry[]>(() => {
  if (!currentErrorMessage.value) return [];

  const currentErrorAtMs = toTimeMs(props.account.lastErrorAt);
  const history = (historyEntries.value ?? []).filter((entry) => {
    const entryCreatedAtMs = toTimeMs(entry.createdAt);
    if (currentErrorAtMs && entryCreatedAtMs && entryCreatedAtMs > currentErrorAtMs + 1000) return false;

    const isSameError = entry.errorCode === props.account.lastErrorCode && entry.errorMessage === currentErrorMessage.value;
    if (!isSameError) return true;
    if (!currentErrorAtMs) return false;

    return !entryCreatedAtMs || Math.abs(entryCreatedAtMs - currentErrorAtMs) > 1000;
  }).sort((a, b) => (toTimeMs(b.createdAt) ?? 0) - (toTimeMs(a.createdAt) ?? 0));

  return [
    {
      id: "current",
      model: currentErrorModel.value,
      errorCode: props.account.lastErrorCode,
      errorMessage: currentErrorMessage.value,
      createdAt: props.account.lastErrorAt,
      isCurrent: true,
    },
    ...history.map((entry) => ({
      id: entry.id,
      model: entry.model ?? getErrorMessageModel(entry.errorMessage, entry.errorCode),
      errorCode: entry.errorCode,
      errorMessage: entry.errorMessage,
      createdAt: entry.createdAt,
      isCurrent: false,
    })),
  ];
});
const errorPreviewWindowStart = computed(() => {
  const total = allErrorPreviewEntries.value.length;
  if (total <= ERROR_PREVIEW_VISIBLE_COUNT) return 0;

  return Math.min(Math.max(activeErrorIndex.value - ERROR_PREVIEW_CENTER_INDEX, 0), total - ERROR_PREVIEW_VISIBLE_COUNT);
});
const errorPreviewEntries = computed<ErrorPreviewEntry[]>(() => allErrorPreviewEntries.value.slice(errorPreviewWindowStart.value, errorPreviewWindowStart.value + ERROR_PREVIEW_VISIBLE_COUNT));
const activeErrorEntry = computed<ErrorPreviewEntry | null>(() => allErrorPreviewEntries.value[activeErrorIndex.value] ?? allErrorPreviewEntries.value[0] ?? null);
const errorPreviewToneClass = computed(() => {
  const toneClass = getErrorToneClass(activeErrorEntry.value);
  return toneClass === "text-foreground" ? "text-foreground/80" : toneClass;
});

function getErrorPreviewSliderDotClass(entry: ErrorPreviewEntry, isActive: boolean): string {
  const toneClass = getErrorToneClass(entry);

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

const displayErrorMessage = computed(() => activeErrorEntry.value ? stripStatusFromErrorMessage(activeErrorEntry.value.errorMessage, activeErrorEntry.value.errorCode) : "");
const errorDetails = computed(() => activeErrorEntry.value ? parseStoredErrorMessage(activeErrorEntry.value.errorMessage, activeErrorEntry.value.errorCode) : null);
const errorPlaygroundRoute = computed(() => {
  const details = errorDetails.value;
  const query: Record<string, string> = { accountId: props.account.id };
  const model = details?.model?.trim();
  const endpoint = normalizePlaygroundEndpoint(details?.endpoint);
  const params = parseErrorParameters(details?.parameters);

  if (model) query.model = model;
  if (endpoint) query.endpoint = endpoint;
  if (params) {
    addPlaygroundParam(query, params, "stream");
    addPlaygroundParam(query, params, "temperature");
    addPlaygroundParam(query, params, "top_p");
    addPlaygroundParam(query, params, "max_tokens", ["max_output_tokens", "max_completion_tokens"]);
    addPlaygroundParam(query, params, "presence_penalty");
    addPlaygroundParam(query, params, "frequency_penalty");
    addPlaygroundParam(query, params, "reasoning_effort");

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

    addAdditionalPlaygroundParams(query, params);
  }

  return { path: "/dashboard/playground", query };
});
const hasPreviousErrorPreview = computed(() => activeErrorIndex.value < allErrorPreviewEntries.value.length - 1);
const hasNewerErrorPreview = computed(() => activeErrorIndex.value > 0);

watch(
  () => [props.account.id, props.account.lastErrorMessage, props.account.lastErrorAt, props.account.lastErrorCode] as const,
  ([id, message], previous) => {
    activeErrorIndex.value = 0;
    historyRequestId += 1;
    if (previous && id !== previous[0]) historyEntries.value = null;
    historyError.value = null;

    if (!message) return;
    loadErrorHistory();
  },
  { immediate: true }
);

watch([statMetrics, statAnimationContextKey, () => props.animateDeltas], ([items, contextKey, animateDeltas]) => {
  const nextValues = collectStatValues(items);

  if (animateDeltas === false) {
    previousStatValues.value = nextValues;
    previousStatAnimationContextKey.value = contextKey;
    pendingStatBaselineContextKey.value = null;
    statHitEffects.value = {};
    return;
  }

  const previousValues = previousStatValues.value;
  const previousContextKey = previousStatAnimationContextKey.value;
  const contextChanged = previousContextKey !== contextKey;

  if (contextChanged) {
    previousStatValues.value = nextValues;
    previousStatAnimationContextKey.value = contextKey;
    pendingStatBaselineContextKey.value = previousContextKey === null ? null : contextKey;
    statHitEffects.value = {};
    return;
  }

  if (!previousValues || pendingStatBaselineContextKey.value === contextKey) {
    previousStatValues.value = nextValues;
    pendingStatBaselineContextKey.value = null;
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
  previousStatAnimationContextKey.value = contextKey;
  statHitEffects.value = nextHitEffects;
}, { immediate: true });

watch(allErrorPreviewEntries, (entries) => {
  if (activeErrorIndex.value >= entries.length) activeErrorIndex.value = Math.max(0, entries.length - 1);
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
  if (props.readonly) return;
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

onBeforeUnmount(() => {
  clearTemporaryOffLongPress();
});

async function toggleActive() {
  if (props.readonly) return;
  if (suppressNextToggle) {
    suppressNextToggle = false;
    return;
  }

  isToggling.value = true;
  try {
    const result = await dashboardApi.accounts.update({ id: props.account.id, isActive: !props.account.isActive });
    if (!result.success) throw new Error(result.error);
    emit("active-updated", result.data);
  } finally {
    isToggling.value = false;
  }
}

async function disableTemporarily() {
  if (props.readonly) return;
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
    emit("temporarily-disabled", result.data);
  } catch (error) {
    temporaryOffError.value = error instanceof Error ? error.message : "Failed to disable account temporarily";
  } finally {
    isTemporaryDisabling.value = false;
  }
}

async function renameAccount() {
  if (props.readonly) return;
  savingName.value = true;
  try {
    const result = await dashboardApi.accounts.update({ id: props.account.id, name: editName.value });
    if (!result.success) throw new Error(result.error);
    editDialogOpen.value = false;
    emit("renamed", result.data);
  } finally {
    savingName.value = false;
  }
}

async function deleteAccount() {
  if (props.readonly) return;
  deleting.value = true;
  try {
    const result = await dashboardApi.accounts.delete({ id: props.account.id });
    if (!result.success) throw new Error(result.error);
    deleteDialogOpen.value = false;
    emit("deleted", props.account.id);
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
    activeErrorIndex.value = 0;
    historyRequestId += 1;
    historyEntries.value = null;
    historyError.value = null;
    emit("errors-resolved", props.account.id);
  } finally {
    resolvingErrors.value = false;
  }
}

async function loadErrorHistory() {
  const requestId = ++historyRequestId;

  try {
    const result = await dashboardApi.accounts.errorHistory({ accountId: props.account.id, limit: 100 });
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

  if (!activeErrorEntry.value || !(await copyToClipboard(activeErrorEntry.value.errorMessage))) return;
  copiedErrorPreview.value = true;
  resetFlag(copiedErrorPreview);
}

async function copyErrorDetails() {
  if (!activeErrorEntry.value || !(await copyToClipboard(activeErrorEntry.value.errorMessage))) return;
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

function getErrorEntryRelativeTime(entry: ErrorPreviewEntry): string {
  if (!entry.createdAt) return entry.isCurrent ? "Current" : "Unknown time";
  const createdAt = new Date(entry.createdAt);
  return Number.isNaN(createdAt.getTime()) ? "Unknown time" : formatRelativeTime(createdAt);
}

function getErrorEntryPreview(entry: ErrorPreviewEntry, maxLength = 150): string {
  const message = stripStatusFromErrorMessage(entry.errorMessage, entry.errorCode);
  return message.length > maxLength ? `${message.slice(0, maxLength)}...` : message;
}

function getErrorEntryStatusTag(entry: ErrorPreviewEntry): ErrorStatusTag | null {
  return getErrorStatusTag(entry.errorCode);
}

function showNewerErrorPreview(event?: Event) {
  event?.stopPropagation();
  activeErrorIndex.value = Math.max(0, activeErrorIndex.value - 1);
}

function showPreviousErrorPreview(event?: Event) {
  event?.stopPropagation();
  activeErrorIndex.value = Math.min(allErrorPreviewEntries.value.length - 1, activeErrorIndex.value + 1);
}

function openActiveErrorDialog() {
  if (suppressNextErrorPreviewClick) {
    suppressNextErrorPreviewClick = false;
    return;
  }

  errorDialogOpen.value = true;
}

function handleErrorPreviewPointerDown(event: PointerEvent) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  errorPreviewDragStartX = event.clientX;
}

function handleErrorPreviewPointerEnd(event: PointerEvent) {
  if (errorPreviewDragStartX === null) return;

  const deltaX = event.clientX - errorPreviewDragStartX;
  errorPreviewDragStartX = null;

  if (Math.abs(deltaX) < ERROR_PREVIEW_SWIPE_THRESHOLD_PX) return;

  suppressNextErrorPreviewClick = true;
  if (deltaX < 0) showPreviousErrorPreview(event);
  else showNewerErrorPreview(event);
}

function cancelErrorPreviewPointer() {
  errorPreviewDragStartX = null;
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
            <UiBadge v-if="showTierBadge" variant="outline" :class="isPaidTierValue(normalizedTier, account.provider) ? 'border-green-500 text-green-600' : ''">
              {{ tierBadgeLabel }}
            </UiBadge>
            <UiBadge v-if="account.status === 'failed'" variant="outline" class="border-destructive/60 text-destructive gap-1">
              <UiIcon name="i-lucide-alert-circle" class="size-3" />
              {{ account.consecutiveErrors }}
            </UiBadge>
            <UiBadge v-else-if="account.status === 'degraded'" variant="outline" class="border-yellow-500 text-yellow-600 gap-1">
              <UiIcon name="i-lucide-triangle-alert" class="size-3" />
              {{ account.consecutiveErrors }}
            </UiBadge>
            <UiBadge v-else-if="account.status === 'half_open'" variant="outline" class="border-yellow-500 text-yellow-600 gap-1">
              <UiIcon name="i-lucide-activity" class="size-3" />
              Unhealty
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
          <p :class="['min-w-0 font-mono text-sm text-muted-foreground', isSubtitleVisible ? 'break-all whitespace-normal' : 'truncate whitespace-nowrap']">{{ subtitleDisplay }}</p>
        </div>
      </UiCardHeader>
      <UiCardContent class="flex flex-1 flex-col pt-0">
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
              <UsageSparkline :values="durationValues" :color="usageChartColorAlt" :aria-label="`Average duration trend for ${accountTitle} over last 24 hours`" class="h-6" :height="24" />
              <div class="mt-0.5 grid grid-cols-5 text-[9px]">
                <span v-for="point in durationLabelPoints" :key="point.time" :class="['truncate text-center', isPreviousDayLabel(point.time) ? 'text-muted-foreground' : 'text-foreground/80']">{{ formatHourLabel(point.time) }}</span>
              </div>
            </div>
            <UsageSparkline :values="dailyValues" :color="usageChartColor" :aria-label="`Requests trend for ${accountTitle}`" />
          </div>

          <div class="flex justify-between"><span class="text-muted-foreground">Last used</span><span class="font-medium">{{ account.lastUsedAt ? formatRelativeTime(account.lastUsedAt) : '-' }}</span></div>
          <div class="flex justify-between"><span class="text-muted-foreground">Last error</span><span :class="['font-medium', account.lastErrorAt ? errorToneClass : 'text-muted-foreground']">{{ account.lastErrorAt ? formatRelativeTime(account.lastErrorAt) : '-' }}</span></div>

          <div class="min-h-14">
            <div class="space-y-1.5 pt-2">
              <div class="h-32 pb-1">
                <div
                  v-if="account.lastErrorMessage && activeErrorEntry"
                  tabindex="-1"
                  class="flex h-full cursor-pointer touch-pan-y flex-col rounded-sm border border-border/60 bg-muted/30 px-2 pt-2 pb-2 text-left select-none hover:bg-muted/40"
                  @click="openActiveErrorDialog"
                  @pointerdown="handleErrorPreviewPointerDown"
                  @pointerup="handleErrorPreviewPointerEnd"
                  @pointerleave="cancelErrorPreviewPointer"
                  @pointercancel="cancelErrorPreviewPointer"
                >
                  <div class="flex items-center justify-between gap-1">
                    <span v-if="getErrorEntryStatusTag(activeErrorEntry)" class="flex min-w-0 items-center gap-1.5">
                      <UiBadge variant="outline" class="h-5 shrink-0 px-1.5 py-0 text-[10px] font-medium">{{ getErrorEntryStatusTag(activeErrorEntry)?.code }}</UiBadge>
                      <span class="truncate text-xs text-muted-foreground">{{ getErrorEntryStatusTag(activeErrorEntry)?.label }}</span>
                    </span>
                    <span v-else class="text-xs text-muted-foreground">No status code</span>
                    <UiTooltip text="Copy">
                      <button
                        type="button"
                        class="shrink-0 cursor-pointer rounded p-0.5"
                        :aria-label="activeErrorEntry.isCurrent ? 'Copy current error message' : 'Copy previous error message'"
                        @click="copyErrorPreview"
                      >
                        <UiIcon v-if="copiedErrorPreview" name="i-lucide-check" class="size-3 text-muted-foreground" />
                        <UiIcon v-else name="i-lucide-copy" class="size-3 text-muted-foreground" />
                      </button>
                    </UiTooltip>
                  </div>
                  <div class="mt-1 flex min-h-0 flex-1 items-center">
                    <span :class="['line-clamp-4 break-all text-xs', errorPreviewToneClass]">{{ getErrorEntryPreview(activeErrorEntry) }}</span>
                  </div>
                  <div class="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground/80">
                    <span>{{ getErrorEntryRelativeTime(activeErrorEntry) }}</span>
                    <span class="min-w-0 truncate text-right font-mono">{{ activeErrorEntry.model }}</span>
                  </div>
                </div>
                <div v-else class="flex h-full w-full items-center justify-center rounded-sm border border-border/60 bg-muted/20 px-2 text-center text-xs text-muted-foreground">
                  No data
                </div>
              </div>

              <div class="flex items-center justify-between gap-2">
                <UiTooltip text="Newer">
                  <UiButton type="button" variant="outline" size="icon-sm" class="h-6 w-6" :disabled="!hasNewerErrorPreview" aria-label="Show newer error" @click="showNewerErrorPreview">
                    <UiIcon name="i-lucide-chevron-left" class="size-3.5" />
                  </UiButton>
                </UiTooltip>
                <div class="flex min-w-0 flex-1 items-center justify-center gap-1">
                  <span v-if="historyError" class="truncate text-[10px] text-red-500">{{ historyError }}</span>
                  <template v-else>
                    <span
                      v-for="(entry, index) in errorPreviewEntries"
                      :key="index"
                      :class="['h-1.5 rounded-full', getErrorPreviewSliderDotClass(entry, errorPreviewWindowStart + index === activeErrorIndex)]"
                    />
                  </template>
                </div>
                <UiTooltip text="Older">
                  <UiButton type="button" variant="outline" size="icon-sm" class="h-6 w-6" :disabled="!hasPreviousErrorPreview" aria-label="Show previous error" @click="showPreviousErrorPreview">
                    <UiIcon name="i-lucide-chevron-right" class="size-3.5" />
                  </UiButton>
                </UiTooltip>
              </div>
            </div>
          </div>

          <div v-if="supportsQuotaMonitor" class="mt-3 space-y-2 border-t pt-3">
            <div>
              <span class="text-xs font-medium text-muted-foreground">Quota</span>
            </div>

            <div v-if="!quotaInfo && !quotaError" class="space-y-2" aria-hidden="true">
              <div v-for="(row, index) in quotaSkeletonRows" :key="index" class="space-y-1">
                <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs">
                  <UiSkeleton :class="['h-3', row.labelClass]" />
                  <span class="flex min-w-0 max-w-28 shrink-0 items-center justify-end gap-1.5 overflow-hidden">
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
                  <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs">
                    <span class="min-w-0 overflow-hidden truncate text-muted-foreground">{{ group.displayName }}</span>
                    <span class="flex min-w-0 max-w-28 shrink-0 items-center justify-end gap-1.5 overflow-hidden">
                      <UiTooltip v-if="group.resetInHuman" :text="quotaResetTitle(group)">
                        <span class="block max-w-20 truncate text-[10px] text-muted-foreground">
                          {{ group.resetInHuman }}
                        </span>
                      </UiTooltip>
                      <span :class="['shrink-0 font-mono', quotaTextColor(group)]">{{ quotaPercentRemaining(group) }}%</span>
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
              <NuxtLink :to="`/dashboard/playground?accountId=${account.id}`">
                <UiButton variant="outline" size="sm"><UiIcon name="i-lucide-flask-conical" class="size-3" /></UiButton>
              </NuxtLink>
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
              <UiButton type="button" variant="outline" size="icon-sm" aria-label="Copy all errors" @click="copyAllErrors">
                <UiIcon :name="copiedAllErrors ? 'i-lucide-check' : 'i-lucide-clipboard-list'" class="size-4" />
              </UiButton>
            </UiTooltip>
            <UiTooltip text="Copy">
              <UiButton type="button" variant="outline" size="icon-sm" aria-label="Copy error details" @click="copyErrorDetails">
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
