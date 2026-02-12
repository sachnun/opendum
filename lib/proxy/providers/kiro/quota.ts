import { KIRO_REGION } from "./constants";

const KIRO_USAGE_LIMITS_URL =
  process.env.KIRO_USAGE_LIMITS_URL ||
  `https://q.${KIRO_REGION}.amazonaws.com/`;
const KIRO_USAGE_REQUEST_TIMEOUT_MS = 10000;
const KIRO_USAGE_TARGET = "AmazonCodeWhispererService.GetUsageLimits";
const KIRO_DEFAULT_USER_AGENT = "KiroIDE-0.7.45";

type JsonRecord = Record<string, unknown>;

const KIRO_METRIC_DISPLAY_NAMES: Record<string, string> = {
  AI_EDITOR: "Kiro requests",
  AGENTIC_REQUEST: "Agentic requests",
  CODE_COMPLETIONS: "Code completions",
  TRANSFORM: "Transform",
  CREDIT: "Credits",
  VIBE: "Vibe usage",
  SPEC: "Spec usage",
};

export interface KiroQuotaMetric {
  name: string;
  displayName: string;
  currentUsage: number;
  usageLimit: number;
  percentUsed: number | null;
  resetTimeIso: string | null;
}

export interface KiroQuotaSnapshot {
  status: "success" | "error";
  error?: string;
  tier: string | null;
  metrics: KiroQuotaMetric[];
  fetchedAt: number;
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as JsonRecord;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function toStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function toTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) {
      return null;
    }

    return value > 10_000_000_000
      ? Math.trunc(value)
      : Math.trunc(value * 1000);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsedMillis = Date.parse(value);
    if (Number.isFinite(parsedMillis) && parsedMillis > 0) {
      return parsedMillis;
    }

    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric > 10_000_000_000
        ? Math.trunc(numeric)
        : Math.trunc(numeric * 1000);
    }
  }

  return null;
}

function toIsoTimestamp(value: unknown): string | null {
  const timestamp = toTimestampMs(value);
  if (!timestamp) {
    return null;
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function toDisplayName(metricName: string): string {
  const normalizedName = metricName.trim().toUpperCase();
  const mapped = KIRO_METRIC_DISPLAY_NAMES[normalizedName];
  if (mapped) {
    return mapped;
  }

  return normalizedName
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeSubscriptionTier(
  rawType: string | null,
  subscriptionTitle: string | null
): string | null {
  const normalizedType = rawType?.trim().toUpperCase() ?? "";
  switch (normalizedType) {
    case "Q_DEVELOPER_STANDALONE_FREE":
      return "free";
    case "Q_DEVELOPER_STANDALONE_POWER":
      return "power";
    case "Q_DEVELOPER_STANDALONE_PRO":
      return "pro";
    case "Q_DEVELOPER_STANDALONE_PRO_PLUS":
      return "pro-plus";
    case "Q_DEVELOPER_STANDALONE":
      return "standalone";
    default:
      break;
  }

  const normalizedTitle = subscriptionTitle?.trim().toLowerCase() ?? "";
  if (!normalizedTitle) {
    return null;
  }

  if (normalizedTitle.includes("pro+") || normalizedTitle.includes("pro plus")) {
    return "pro-plus";
  }

  if (normalizedTitle.includes("pro")) {
    return "pro";
  }

  if (normalizedTitle.includes("power")) {
    return "power";
  }

  if (normalizedTitle.includes("free")) {
    return "free";
  }

  return normalizedTitle
    .split(/[_\s-]+/)
    .filter(Boolean)
    .join("-");
}

function parseMetricFromLimitsRecord(
  value: unknown,
  fallbackResetTimeIso: string | null
): KiroQuotaMetric | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const metricName = toStringValue(record.type);
  const currentUsage = toNumber(record.currentUsage);
  const usageLimit = toNumber(record.totalUsageLimit);
  if (!metricName || currentUsage === null || usageLimit === null || usageLimit <= 0) {
    return null;
  }

  const percentUsed = toNumber(record.percentUsed);
  const resetTimeIso =
    toIsoTimestamp(record.nextDateReset) ?? fallbackResetTimeIso;

  return {
    name: metricName.toUpperCase(),
    displayName: toDisplayName(metricName),
    currentUsage,
    usageLimit,
    percentUsed,
    resetTimeIso,
  };
}

function parseMetricFromBreakdownRecord(
  value: unknown,
  fallbackResetTimeIso: string | null
): KiroQuotaMetric | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const resourceType = toStringValue(record.resourceType);
  const displayName = toStringValue(record.displayName);
  const metricName = resourceType ?? displayName;
  if (!metricName) {
    return null;
  }

  const currentUsage =
    toNumber(record.currentUsageWithPrecision) ??
    toNumber(record.currentUsage);
  const usageLimit =
    toNumber(record.usageLimitWithPrecision) ?? toNumber(record.usageLimit);

  if (currentUsage === null || usageLimit === null || usageLimit <= 0) {
    return null;
  }

  const percentUsed = (currentUsage / usageLimit) * 100;
  const resetTimeIso =
    toIsoTimestamp(record.nextDateReset) ?? fallbackResetTimeIso;

  return {
    name: metricName.toUpperCase(),
    displayName: displayName ?? toDisplayName(metricName),
    currentUsage,
    usageLimit,
    percentUsed,
    resetTimeIso,
  };
}

function parseMetrics(
  payload: JsonRecord,
  fallbackResetTimeIso: string | null
): KiroQuotaMetric[] {
  const metricsByName = new Map<string, KiroQuotaMetric>();

  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  for (const limit of limits) {
    const parsed = parseMetricFromLimitsRecord(limit, fallbackResetTimeIso);
    if (!parsed) {
      continue;
    }

    metricsByName.set(parsed.name, parsed);
  }

  const usageBreakdownList = Array.isArray(payload.usageBreakdownList)
    ? payload.usageBreakdownList
    : [];
  const usageBreakdown = payload.usageBreakdown;

  const breakdownCandidates = usageBreakdownList.length
    ? usageBreakdownList
    : usageBreakdown
      ? [usageBreakdown]
      : [];

  for (const breakdown of breakdownCandidates) {
    const parsed = parseMetricFromBreakdownRecord(
      breakdown,
      fallbackResetTimeIso
    );
    if (!parsed) {
      continue;
    }

    if (!metricsByName.has(parsed.name)) {
      metricsByName.set(parsed.name, parsed);
    }
  }

  return Array.from(metricsByName.values());
}

export async function fetchKiroQuotaFromApi(
  accessToken: string,
  profileArn?: string | null
): Promise<KiroQuotaSnapshot> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    KIRO_USAGE_REQUEST_TIMEOUT_MS
  );

  try {
    const invocationId = crypto.randomUUID();
    const requestPayload: JsonRecord = {
      origin: "AI_EDITOR",
    };

    if (profileArn) {
      requestPayload.profileArn = profileArn;
    }

    const requestUrl = new URL(KIRO_USAGE_LIMITS_URL);
    for (const [key, value] of Object.entries(requestPayload)) {
      requestUrl.searchParams.set(key, String(value));
    }

    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-amz-json-1.0",
        Accept: "application/json",
        "User-Agent": KIRO_DEFAULT_USER_AGENT,
        "x-amz-user-agent": KIRO_DEFAULT_USER_AGENT,
        "x-amz-target": KIRO_USAGE_TARGET,
        "x-amzn-codewhisperer-optout": "true",
        "x-amzn-kiro-agent-mode": "vibe",
        "amz-sdk-invocation-id": invocationId,
        "amz-sdk-request": "attempt=1; max=3",
      },
      body: JSON.stringify(requestPayload),
      cache: "no-store",
      signal: controller.signal,
    });

    const rawBody = await response.text();

    if (!response.ok) {
      return {
        status: "error",
        error: `Kiro usage limits request failed: HTTP ${response.status}${
          rawBody ? ` ${rawBody.slice(0, 250)}` : ""
        }`,
        tier: null,
        metrics: [],
        fetchedAt: Date.now(),
      };
    }

    let payload: unknown = null;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return {
        status: "error",
        error: "Kiro usage limits response was not valid JSON",
        tier: null,
        metrics: [],
        fetchedAt: Date.now(),
      };
    }

    const payloadRecord = asRecord(payload);
    const record = asRecord(payloadRecord?.data) ?? payloadRecord;
    if (!record) {
      return {
        status: "error",
        error: "Kiro usage limits response did not contain an object payload",
        tier: null,
        metrics: [],
        fetchedAt: Date.now(),
      };
    }

    const defaultResetTimeIso = toIsoTimestamp(record.nextDateReset);
    const metrics = parseMetrics(record, defaultResetTimeIso);

    const subscriptionInfo = asRecord(record.subscriptionInfo);
    const tier = normalizeSubscriptionTier(
      toStringValue(subscriptionInfo?.type),
      toStringValue(subscriptionInfo?.subscriptionTitle)
    );

    if (metrics.length === 0) {
      return {
        status: "error",
        error: "Kiro usage limits are unavailable for this account",
        tier,
        metrics: [],
        fetchedAt: Date.now(),
      };
    }

    return {
      status: "success",
      tier,
      metrics,
      fetchedAt: Date.now(),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        status: "error",
        error: "Kiro usage limits request timed out",
        tier: null,
        metrics: [],
        fetchedAt: Date.now(),
      };
    }

    return {
      status: "error",
      error:
        error instanceof Error
          ? error.message
          : "Failed to fetch Kiro usage limits",
      tier: null,
      metrics: [],
      fetchedAt: Date.now(),
    };
  } finally {
    clearTimeout(timeout);
  }
}
