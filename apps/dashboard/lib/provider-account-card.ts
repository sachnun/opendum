import { formatDistanceToNowStrict } from "date-fns";
import type { ProviderDetailData, QuotaGroupDisplay } from "~~/lib/api-types";

export type ParsedErrorDetails = {
  error: string | null;
  provider: string | null;
  endpoint: string | null;
  model: string | null;
  parameters: string | null;
  messageObjects: string[] | null;
};

export type ErrorStatusTag = {
  code: number;
  label: string;
};

export type StatDeltaTone = "positive" | "negative" | "neutral";

export type StatMetric = { key: string; label: string; value: string; numericValue: number; formatDelta: (delta: number) => string; getTone?: (delta: number) => StatDeltaTone };

export type DurationPoint = { time: string; avgDuration: number | null };

export type ErrorPlaygroundEndpoint = "chat_completions" | "messages" | "responses";

export type ErrorPreviewEntry = {
  id: string;
  model: string | null;
  errorCode: number | null;
  errorMessage: string;
  createdAt: string | Date | null;
};

export type Account = ProviderDetailData["accounts"][number];

export const HTTP_STATUS_DESCRIPTIONS: Record<number, string> = {
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

export function parseStoredErrorMessage(rawMessage: string, code: number | null | undefined): ParsedErrorDetails {
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

export function formatDuration(duration: number | null): string {
  if (duration === null) return "-";
  if (duration >= 1000) return `${(duration / 1000).toFixed(2)}s`;
  return `${duration}ms`;
}

export function compactNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return n.toLocaleString();
}

export function formatSignedInteger(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  return `${sign} ${compactNumber(Math.abs(Math.round(delta)))}`;
}

export function formatSignedDuration(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  return `${sign} ${formatDuration(Math.abs(Math.round(delta)))}`;
}

export function formatSignedPercent(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  const value = Math.round(Math.abs(delta) * 10) / 10;
  return `${sign} ${value}%`;
}

export function collectStatValues(items: StatMetric[]): Record<string, number> {
  const values: Record<string, number> = {};

  for (const item of items) {
    if (Number.isFinite(item.numericValue)) values[item.key] = item.numericValue;
  }

  return values;
}

export function buildHourKeys(hours: number): string[] {
  const now = new Date();
  const currentHourUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));

  return Array.from({ length: hours }, (_, index) => {
    const date = new Date(currentHourUtc);
    date.setUTCHours(currentHourUtc.getUTCHours() - (hours - 1 - index));
    return date.toISOString();
  });
}

export function buildDayKeys(days: number): string[] {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(todayUtc);
    date.setUTCDate(todayUtc.getUTCDate() - (days - 1 - index));
    return date.toISOString().split("T")[0] ?? "";
  });
}

export function expandDailyPoints(points: Array<{ date: string; count: number }>) {
  const valuesByDate = new Map(points.map((point) => [point.date, point.count]));
  return buildDayKeys(30).map((date) => ({ date, count: valuesByDate.get(date) ?? 0 }));
}

export function expandDurationPoints(points: Array<{ time: string; avgDuration: number }>): DurationPoint[] {
  const valuesByTime = new Map(points.map((point) => [point.time, point.avgDuration]));
  return buildHourKeys(24).map((time) => ({ time, avgDuration: valuesByTime.get(time) ?? null }));
}

export function formatRelativeTime(value: string | Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  const relative = formatDistanceToNowStrict(date, { addSuffix: true });
  return relative === "0 seconds ago" ? "just now" : relative;
}

export function toTimeMs(value: string | Date | null | undefined): number | null {
  if (!value) return null;

  const timeMs = new Date(value).getTime();
  return Number.isNaN(timeMs) ? null : timeMs;
}

export function getHttpStatusDescription(code: number): string {
  return HTTP_STATUS_DESCRIPTIONS[code] ?? "HTTP Error";
}

export function getErrorStatusTag(code: number | null | undefined): ErrorStatusTag | null {
  return code ? { code, label: getHttpStatusDescription(code) } : null;
}

export function stripStatusFromErrorMessage(message: string, code: number | null | undefined): string {
  const trimmed = message.trimStart().replace(/^Error:\s*/i, "");
  if (!code) return trimmed;

  return trimmed
    .replace(new RegExp(`^\\[${code}\\]\\s*(?:error:\\s*)?`, "i"), "")
    .replace(new RegExp(`^HTTP\\s+${code}\\s*[:\\-]?\\s*(?:error:\\s*)?`, "i"), "")
    .replace(/^Error:\s*/i, "")
    .trimStart();
}

export function getErrorMessageModel(message: string, code: number | null | undefined): string | null {
  return parseStoredErrorMessage(message, code).model?.trim() || null;
}

export function normalizePlaygroundEndpoint(value: string | null | undefined): ErrorPlaygroundEndpoint | null {
  const normalized = value?.trim().replace(/^\/v1\//, "") ?? "";
  if (normalized === "chat/completions" || normalized === "chat_completions") return "chat_completions";
  if (normalized === "messages") return "messages";
  if (normalized === "responses") return "responses";
  return null;
}

export function parseErrorParameters(value: string | null | undefined): Record<string, unknown> | null {
  if (!value?.trim()) return null;

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function addPlaygroundParam(query: Record<string, string>, params: Record<string, unknown>, targetKey: string, sourceKeys: string[] = []) {
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

export function addAdditionalPlaygroundParams(query: Record<string, string>, params: Record<string, unknown>) {
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

export function formatHourLabel(time: string): string {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? time.slice(11, 16) : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function isPreviousDayLabel(time: string): boolean {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

export function isPaidTierValue(tier: string, provider?: string): boolean {
  const value = tier.trim().toLowerCase();
  if (provider === "antigravity") return ["paid", "standard-tier"].includes(value) || value.startsWith("g1-");
  if (provider === "kiro") return ["pro", "pro-plus", "pro+", "power"].includes(value);
  return ["paid", "standard-tier", "plus", "pro", "pro-plus", "pro+", "prolite", "power", "team", "go", "self_serve_business_usage_based", "business", "enterprise_cbp_usage_based", "enterprise", "student", "edu", "education", "hc"].includes(value);
}

export function isFreeTierValue(tier: string): boolean {
  return ["free", "free-tier", "legacy-tier"].includes(tier.trim().toLowerCase());
}

export function formatTierBadgeLabel(tier: string, provider?: string): "Paid" | "Free" | "" {
  if (isPaidTierValue(tier, provider)) return "Paid";
  if (isFreeTierValue(tier)) return "Free";
  return "";
}

export function maskSensitiveText(value: string): string {
  return value.replace(/\S/g, "•");
}

export function getAccountHeader(account: Account): { title: string; subtitle: string | null } {
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

export function isImmediatelyRecoverableErrorCode(code: number | null | undefined): boolean {
  if (!code) return false;
  return code === 408 || code === 429 || (code >= 500 && code <= 599);
}

export function quotaPercentRemaining(group: QuotaGroupDisplay): number {
  return Math.max(0, Math.min(100, Math.round(group.remainingFraction * 100)));
}

export function quotaResetTitle(group: QuotaGroupDisplay): string | undefined {
  if (!group.resetTimeIso) return undefined;
  const resetDate = new Date(group.resetTimeIso);
  return Number.isNaN(resetDate.getTime()) ? undefined : resetDate.toLocaleString();
}

export function formatDateTime(value: Date): string {
  return value.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function getErrorEntryRelativeTime(entry: ErrorPreviewEntry): string {
  if (!entry.createdAt) return "Unknown time";
  const createdAt = new Date(entry.createdAt);
  return Number.isNaN(createdAt.getTime()) ? "Unknown time" : formatRelativeTime(createdAt);
}

export function getErrorEntryPreview(entry: ErrorPreviewEntry, maxLength = 150): string {
  const message = stripStatusFromErrorMessage(entry.errorMessage, entry.errorCode);
  return message.length > maxLength ? `${message.slice(0, maxLength)}...` : message;
}

export function getErrorEntryStatusTag(entry: ErrorPreviewEntry): ErrorStatusTag | null {
  return getErrorStatusTag(entry.errorCode);
}
