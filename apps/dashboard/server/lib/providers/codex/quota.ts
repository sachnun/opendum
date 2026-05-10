/**
 * Codex Quota Monitoring
 *
 * Tracks Codex usage windows by reading:
 * - GET /backend-api/wham/usage payload
 * - x-codex-* response headers from regular requests
 */

import { CODEX_CHAT_USER_AGENT, ORIGINATOR } from "./constants.js";
import { getRedisJson, setRedisJson } from "../../../redis-cache.js";
import { fetchInternalProvider } from "../../proxy/internal-relay.js";
import { formatQuotaHttpError } from "../provider-http-errors.js";

const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const CHATGPT_ORIGIN = "https://chatgpt.com";

const QUOTA_STALE_MS = 15 * 60 * 1000;
const CACHE_PREFIX = "opendum:quota:codex:snapshot";
const CACHE_TTL_SECONDS = Math.ceil(QUOTA_STALE_MS / 1000);

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

function getCodexQuotaCacheKey(accountId: string): string {
  return `${CACHE_PREFIX}:${accountId}`;
}

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

  const balance = typeof balanceRaw === "string" ? balanceRaw : typeof balanceRaw === "number" && Number.isFinite(balanceRaw) ? String(balanceRaw) : null;

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

function formatQuotaFetchError(response: Response, body: string): string {
  return formatQuotaHttpError("Codex", response, body, {
    endpointLabel: "quota endpoint",
  }).replace(" from Cloudflare", " from ChatGPT/Cloudflare");
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

async function getCodexQuotaSnapshot(
  accountId: string
): Promise<CodexQuotaSnapshot | null> {
  const snapshot = await getRedisJson<CodexQuotaSnapshot>(
    getCodexQuotaCacheKey(accountId)
  );

  if (!snapshot || snapshot.status !== "success") {
    return null;
  }

  return snapshot;
}

async function setCodexQuotaSnapshot(
  accountId: string,
  snapshot: CodexQuotaSnapshot
): Promise<void> {
  if (snapshot.status !== "success") {
    return;
  }

  await setRedisJson(
    getCodexQuotaCacheKey(accountId),
    snapshot,
    CACHE_TTL_SECONDS
  );
}

export async function updateCodexQuotaFromHeaders(
  accountId: string,
  headers: Headers | Record<string, string>
): Promise<CodexQuotaSnapshot | null> {
  const parsedFromHeaders = parseQuotaFromHeaders(headers);
  if (!parsedFromHeaders) {
    return null;
  }

  const existingSnapshot = await getCodexQuotaSnapshot(accountId);
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
  await setCodexQuotaSnapshot(accountId, snapshot);
  return snapshot;
}

export async function fetchCodexQuotaFromApi(
  accessToken: string,
  chatgptAccountId?: string | null
): Promise<CodexQuotaSnapshot> {
  try {
    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": CODEX_CHAT_USER_AGENT,
      Origin: CHATGPT_ORIGIN,
      Referer: `${CHATGPT_ORIGIN}/`,
      originator: ORIGINATOR,
    };

    if (chatgptAccountId) {
      requestHeaders["ChatGPT-Account-Id"] = chatgptAccountId;
    }

    const response = await fetchInternalProvider(USAGE_ENDPOINT, {
      method: "GET",
      headers: requestHeaders,
    });

    const headerData = parseQuotaFromHeaders(response.headers);

    if (!response.ok) {
      const errorBody = await response.text();

      if (headerData) {
        return toSnapshot(headerData, "headers");
      }

      return {
        status: "error",
        error: formatQuotaFetchError(response, errorBody),
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
