/**
 * Codex Quota Monitoring
 *
 * Tracks Codex usage windows by reading:
 * - GET /backend-api/wham/usage payload
 * - x-codex-* response headers from regular requests
 */

import { CODEX_ORIGINATOR } from "./constants";

const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_DEFAULT_USER_AGENT = "codex-cli";

export const CODEX_QUOTA_STALE_THRESHOLD_MS = 15 * 60 * 1000;

export interface CodexRateLimitWindow {
  usedPercent: number;
  remainingPercent: number;
  remainingFraction: number;
  windowMinutes: number | null;
  resetAt: number | null; // unix seconds
  resetTimestamp: number | null; // unix ms
  isExhausted: boolean;
}

export interface CodexCreditsInfo {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexQuotaSnapshot {
  status: "success" | "error";
  error?: string;
  planType: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: CodexCreditsInfo | null;
  fetchedAt: number;
  source: "api" | "headers";
}

interface ParsedCodexQuota {
  planType: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: CodexCreditsInfo | null;
}

const quotaSnapshots = new Map<string, CodexQuotaSnapshot>();

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
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

function toInteger(value: unknown): number | null {
  const parsed = toNumber(value);
  if (parsed === null) {
    return null;
  }

  return Math.trunc(parsed);
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }

    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }

  return null;
}

function windowMinutesFromSeconds(seconds: number | null): number | null {
  if (seconds === null || seconds <= 0) {
    return null;
  }

  return Math.ceil(seconds / 60);
}

function toResetTimestamp(resetAt: number | null): number | null {
  if (resetAt === null || resetAt <= 0) {
    return null;
  }

  if (resetAt > 10_000_000_000) {
    return Math.trunc(resetAt);
  }

  return Math.trunc(resetAt * 1000);
}

function buildRateLimitWindow(
  usedPercentRaw: number,
  windowMinutes: number | null,
  resetAt: number | null
): CodexRateLimitWindow {
  const usedPercent = Math.min(100, Math.max(0, usedPercentRaw));
  const remainingPercent = Math.min(100, Math.max(0, 100 - usedPercent));

  return {
    usedPercent,
    remainingPercent,
    remainingFraction: remainingPercent / 100,
    windowMinutes,
    resetAt,
    resetTimestamp: toResetTimestamp(resetAt),
    isExhausted: usedPercent >= 100,
  };
}

function parseWindowFromApi(value: unknown): CodexRateLimitWindow | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const usedPercent = toNumber(record.used_percent);
  if (usedPercent === null) {
    return null;
  }

  const windowSeconds = toInteger(record.limit_window_seconds);
  const resetAt = toInteger(record.reset_at);

  return buildRateLimitWindow(
    usedPercent,
    windowMinutesFromSeconds(windowSeconds),
    resetAt
  );
}

function toHeaderMap(headers: Headers | Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      map.set(key.toLowerCase(), value);
    });
    return map;
  }

  for (const [key, value] of Object.entries(headers)) {
    map.set(key.toLowerCase(), value);
  }

  return map;
}

function parseWindowFromHeaders(
  headers: Map<string, string>,
  usedPercentHeader: string,
  windowMinutesHeader: string,
  resetAtHeader: string
): CodexRateLimitWindow | null {
  const usedPercent = toNumber(headers.get(usedPercentHeader));
  if (usedPercent === null) {
    return null;
  }

  const windowMinutes = toInteger(headers.get(windowMinutesHeader));
  const resetAt = toInteger(headers.get(resetAtHeader));

  return buildRateLimitWindow(usedPercent, windowMinutes, resetAt);
}

function parseCreditsFromApi(value: unknown): CodexCreditsInfo | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const hasCredits = toBoolean(record.has_credits);
  const unlimited = toBoolean(record.unlimited);
  const balanceRaw = record.balance;

  let balance: string | null = null;
  if (typeof balanceRaw === "string") {
    balance = balanceRaw;
  } else if (typeof balanceRaw === "number" && Number.isFinite(balanceRaw)) {
    balance = String(balanceRaw);
  }

  if (hasCredits === null && unlimited === null && balance === null) {
    return null;
  }

  return {
    hasCredits: hasCredits ?? false,
    unlimited: unlimited ?? false,
    balance,
  };
}

function parseCreditsFromHeaders(headers: Map<string, string>): CodexCreditsInfo | null {
  const hasCredits = toBoolean(headers.get("x-codex-credits-has-credits"));
  if (hasCredits === null) {
    return null;
  }

  const unlimited = toBoolean(headers.get("x-codex-credits-unlimited"));
  const balance = headers.get("x-codex-credits-balance") ?? null;

  return {
    hasCredits,
    unlimited: unlimited ?? false,
    balance,
  };
}

function parseQuotaFromApiPayload(payload: unknown): ParsedCodexQuota | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  const planType = typeof record.plan_type === "string" ? record.plan_type : null;

  const rateLimitRecord = asRecord(record.rate_limit);
  const primary = parseWindowFromApi(rateLimitRecord?.primary_window);
  const secondary = parseWindowFromApi(rateLimitRecord?.secondary_window);
  const credits = parseCreditsFromApi(record.credits);

  if (planType === null && primary === null && secondary === null && credits === null) {
    return null;
  }

  return {
    planType,
    primary,
    secondary,
    credits,
  };
}

function parseQuotaFromHeaders(headers: Headers | Record<string, string>): ParsedCodexQuota | null {
  const normalizedHeaders = toHeaderMap(headers);

  const primary = parseWindowFromHeaders(
    normalizedHeaders,
    "x-codex-primary-used-percent",
    "x-codex-primary-window-minutes",
    "x-codex-primary-reset-at"
  );

  const secondary = parseWindowFromHeaders(
    normalizedHeaders,
    "x-codex-secondary-used-percent",
    "x-codex-secondary-window-minutes",
    "x-codex-secondary-reset-at"
  );

  const credits = parseCreditsFromHeaders(normalizedHeaders);

  if (primary === null && secondary === null && credits === null) {
    return null;
  }

  return {
    planType: null,
    primary,
    secondary,
    credits,
  };
}

function mergeQuotaData(
  apiData: ParsedCodexQuota | null,
  headerData: ParsedCodexQuota | null,
  fallbackData: ParsedCodexQuota | null = null
): ParsedCodexQuota | null {
  if (!apiData && !headerData && !fallbackData) {
    return null;
  }

  return {
    planType: apiData?.planType ?? headerData?.planType ?? fallbackData?.planType ?? null,
    primary: apiData?.primary ?? headerData?.primary ?? fallbackData?.primary ?? null,
    secondary:
      apiData?.secondary ?? headerData?.secondary ?? fallbackData?.secondary ?? null,
    credits: apiData?.credits ?? headerData?.credits ?? fallbackData?.credits ?? null,
  };
}

function toSnapshot(
  data: ParsedCodexQuota,
  source: "api" | "headers",
  fetchedAt = Date.now()
): CodexQuotaSnapshot {
  return {
    status: "success",
    planType: data.planType,
    primary: data.primary,
    secondary: data.secondary,
    credits: data.credits,
    fetchedAt,
    source,
  };
}

export function getCodexQuotaSnapshot(accountId: string): CodexQuotaSnapshot | null {
  return quotaSnapshots.get(accountId) ?? null;
}

export function isCodexQuotaStale(snapshot: CodexQuotaSnapshot): boolean {
  return Date.now() - snapshot.fetchedAt > CODEX_QUOTA_STALE_THRESHOLD_MS;
}

export function setCodexQuotaSnapshot(accountId: string, snapshot: CodexQuotaSnapshot): void {
  if (snapshot.status !== "success") {
    return;
  }

  quotaSnapshots.set(accountId, snapshot);
}

export function updateCodexQuotaFromHeaders(
  accountId: string,
  headers: Headers | Record<string, string>
): CodexQuotaSnapshot | null {
  const parsedFromHeaders = parseQuotaFromHeaders(headers);
  if (!parsedFromHeaders) {
    return null;
  }

  const existingSnapshot = getCodexQuotaSnapshot(accountId);
  const existingParsed: ParsedCodexQuota | null = existingSnapshot
    ? {
        planType: existingSnapshot.planType,
        primary: existingSnapshot.primary,
        secondary: existingSnapshot.secondary,
        credits: existingSnapshot.credits,
      }
    : null;

  const merged = mergeQuotaData(null, parsedFromHeaders, existingParsed);
  if (!merged) {
    return null;
  }

  const snapshot = toSnapshot(merged, "headers");
  quotaSnapshots.set(accountId, snapshot);
  return snapshot;
}

export async function fetchCodexQuotaFromApi(
  accessToken: string,
  chatgptAccountId?: string | null
): Promise<CodexQuotaSnapshot> {
  try {
    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": CODEX_DEFAULT_USER_AGENT,
      originator: CODEX_ORIGINATOR,
    };

    if (chatgptAccountId) {
      requestHeaders["ChatGPT-Account-Id"] = chatgptAccountId;
    }

    const response = await fetch(CODEX_USAGE_ENDPOINT, {
      method: "GET",
      headers: requestHeaders,
      cache: "no-store",
    });

    const headerData = parseQuotaFromHeaders(response.headers);

    if (!response.ok) {
      const errorBody = await response.text();

      if (headerData) {
        return toSnapshot(headerData, "headers");
      }

      return {
        status: "error",
        error: `Codex quota fetch failed: HTTP ${response.status}${
          errorBody ? ` ${errorBody.slice(0, 300)}` : ""
        }`,
        planType: null,
        primary: null,
        secondary: null,
        credits: null,
        fetchedAt: Date.now(),
        source: "api",
      };
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const apiData = parseQuotaFromApiPayload(payload);
    const merged = mergeQuotaData(apiData, headerData);

    if (!merged) {
      return {
        status: "error",
        error: "Codex quota payload did not include usable quota data",
        planType: null,
        primary: null,
        secondary: null,
        credits: null,
        fetchedAt: Date.now(),
        source: "api",
      };
    }

    return toSnapshot(merged, apiData ? "api" : "headers");
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : "Failed to fetch Codex quota",
      planType: null,
      primary: null,
      secondary: null,
      credits: null,
      fetchedAt: Date.now(),
      source: "api",
    };
  }
}
