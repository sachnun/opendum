import type { ModelFamily } from "./providers/antigravity/transform/types";
import { getRedisClient } from "@/lib/redis";

interface RateLimitEntry {
  resetTime: number; // Unix timestamp (ms) when rate limit expires
  model?: string; // Which model triggered the limit
  message?: string; // Error message from API
}

// Map: accountId -> family -> RateLimitEntry
const rateLimits = new Map<string, Map<string, RateLimitEntry>>();
const RATE_LIMIT_KEY_PREFIX = "opendum:rate-limit";
const MAX_RETRY_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

function getRateLimitKey(accountId: string, family: ModelFamily): string {
  return `${RATE_LIMIT_KEY_PREFIX}:${accountId}:${family}`;
}

function parseRateLimitEntry(rawEntry: string | null): RateLimitEntry | null {
  if (!rawEntry) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawEntry) as Partial<RateLimitEntry>;
    if (typeof parsed.resetTime !== "number" || !Number.isFinite(parsed.resetTime)) {
      return null;
    }

    const entry: RateLimitEntry = { resetTime: parsed.resetTime };
    if (typeof parsed.model === "string") {
      entry.model = parsed.model;
    }
    if (typeof parsed.message === "string") {
      entry.message = parsed.message;
    }

    return entry;
  } catch {
    return null;
  }
}

function normalizeRetryAfterMs(retryAfterMs: number): number {
  if (!Number.isFinite(retryAfterMs)) {
    return 60 * 60 * 1000;
  }

  const rounded = Math.floor(retryAfterMs);
  return Math.max(1000, Math.min(MAX_RETRY_AFTER_MS, rounded));
}

function toTtlSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

function setInMemoryRateLimit(
  accountId: string,
  family: ModelFamily,
  entry: RateLimitEntry
): void {
  let accountLimits = rateLimits.get(accountId);
  if (!accountLimits) {
    accountLimits = new Map();
    rateLimits.set(accountId, accountLimits);
  }

  accountLimits.set(family, entry);
}

function clearExpiredInMemoryRateLimits(accountId: string): void {
  const accountLimits = rateLimits.get(accountId);
  if (!accountLimits) return;

  const now = Date.now();
  for (const [family, entry] of accountLimits) {
    if (now >= entry.resetTime) {
      accountLimits.delete(family);
    }
  }

  if (accountLimits.size === 0) {
    rateLimits.delete(accountId);
  }
}

function getInMemoryRateLimitEntry(
  accountId: string,
  family: ModelFamily
): RateLimitEntry | null {
  const accountLimits = rateLimits.get(accountId);
  if (!accountLimits) return null;

  const entry = accountLimits.get(family);
  if (!entry) return null;

  if (Date.now() >= entry.resetTime) {
    accountLimits.delete(family);
    if (accountLimits.size === 0) {
      rateLimits.delete(accountId);
    }
    return null;
  }

  return entry;
}

function deleteInMemoryRateLimit(accountId: string, family: ModelFamily): void {
  const accountLimits = rateLimits.get(accountId);
  if (!accountLimits) return;

  accountLimits.delete(family);
  if (accountLimits.size === 0) {
    rateLimits.delete(accountId);
  }
}

async function getRateLimitEntry(
  accountId: string,
  family: ModelFamily
): Promise<RateLimitEntry | null> {
  const redis = await getRedisClient();
  if (!redis) {
    return getInMemoryRateLimitEntry(accountId, family);
  }

  try {
    const key = getRateLimitKey(accountId, family);
    const rawEntry = await redis.get(key);
    const entry = parseRateLimitEntry(rawEntry);

    if (!rawEntry) {
      return null;
    }

    if (!entry) {
      await redis.del(key);
      return null;
    }

    if (Date.now() >= entry.resetTime) {
      await redis.del(key);
      return null;
    }

    return entry;
  } catch {
    return getInMemoryRateLimitEntry(accountId, family);
  }
}

/**
 * Mark an account as rate limited for a specific model family
 */
export async function markRateLimited(
  accountId: string,
  family: ModelFamily,
  retryAfterMs: number,
  model?: string,
  message?: string
): Promise<void> {
  const normalizedRetryAfterMs = normalizeRetryAfterMs(retryAfterMs);
  const entry: RateLimitEntry = {
    resetTime: Date.now() + normalizedRetryAfterMs,
    model,
    message,
  };

  setInMemoryRateLimit(accountId, family, entry);

  const redis = await getRedisClient();
  if (!redis) {
    return;
  }

  try {
    await redis.set(getRateLimitKey(accountId, family), JSON.stringify(entry), {
      EX: toTtlSeconds(normalizedRetryAfterMs),
    });
  } catch {
    // Ignore Redis errors and keep in-memory fallback
  }
}

/**
 * Check if an account is currently rate limited for a model family
 */
export async function isRateLimited(
  accountId: string,
  family: ModelFamily
): Promise<boolean> {
  const entry = await getRateLimitEntry(accountId, family);
  return entry !== null;
}

/**
 * Clear expired rate limits for an account
 */
export function clearExpiredRateLimits(accountId: string): void {
  clearExpiredInMemoryRateLimits(accountId);
}

/**
 * Get rate limit info for an account + family
 */
export async function getRateLimitInfo(
  accountId: string,
  family: ModelFamily
): Promise<RateLimitEntry | null> {
  return getRateLimitEntry(accountId, family);
}

/**
 * Get set of currently rate-limited account IDs for a model family.
 */
export async function getRateLimitedAccountIds(
  accountIds: string[],
  family: ModelFamily
): Promise<Set<string>> {
  const limitedAccountIds = new Set<string>();

  if (accountIds.length === 0) {
    return limitedAccountIds;
  }

  const redis = await getRedisClient();

  if (redis) {
    const keys = accountIds.map((accountId) => getRateLimitKey(accountId, family));
    const now = Date.now();

    try {
      const entries = await redis.mGet(keys);

      for (let index = 0; index < entries.length; index++) {
        const rawEntry = entries[index];
        const key = keys[index];
        const accountId = accountIds[index];

        if (!rawEntry || !accountId) {
          continue;
        }

        const entry = parseRateLimitEntry(rawEntry);
        if (!entry) {
          if (key) {
            await redis.del(key);
          }
          continue;
        }

        if (now >= entry.resetTime) {
          if (key) {
            await redis.del(key);
          }
          continue;
        }

        limitedAccountIds.add(accountId);
      }

      return limitedAccountIds;
    } catch {
      // Fall through to in-memory fallback below
    }
  }

  for (const accountId of accountIds) {
    const entry = getInMemoryRateLimitEntry(accountId, family);
    if (!entry) {
      continue;
    }

    limitedAccountIds.add(accountId);
  }

  return limitedAccountIds;
}

/**
 * Get minimum wait time across multiple accounts for a family
 * Returns 0 if at least one account is not rate limited
 */
export async function getMinWaitTime(
  accountIds: string[],
  family: ModelFamily
): Promise<number> {
  if (accountIds.length === 0) {
    return 0;
  }

  const redis = await getRedisClient();

  if (redis) {
    const keys = accountIds.map((accountId) => getRateLimitKey(accountId, family));
    const now = Date.now();

    try {
      const entries = await redis.mGet(keys);
      let minWait = Infinity;

      for (let index = 0; index < entries.length; index++) {
        const rawEntry = entries[index];
        const entry = parseRateLimitEntry(rawEntry);
        const key = keys[index];

        if (!rawEntry) {
          return 0;
        }

        if (!entry) {
          if (key) {
            await redis.del(key);
          }
          return 0;
        }

        if (now >= entry.resetTime) {
          if (key) {
            await redis.del(key);
          }
          return 0;
        }

        const waitTime = entry.resetTime - now;
        if (waitTime < minWait) {
          minWait = waitTime;
        }
      }

      return minWait === Infinity ? 0 : minWait;
    } catch {
      // Fall through to in-memory fallback below
    }
  }

  let minWait = Infinity;
  const now = Date.now();

  for (const accountId of accountIds) {
    const entry = getInMemoryRateLimitEntry(accountId, family);
    if (!entry) return 0; // This account not rate limited for this family

    if (now >= entry.resetTime) {
      deleteInMemoryRateLimit(accountId, family);
      return 0; // Expired
    }

    const waitTime = entry.resetTime - now;
    if (waitTime < minWait) {
      minWait = waitTime;
    }
  }

  return minWait === Infinity ? 0 : minWait;
}

/**
 * Parse duration string like "128h12m18.724039275s" to milliseconds
 */
function parseDurationToMs(duration: string): number | null {
  if (!duration) return null;

  // Match patterns like "128h12m18.724039275s" or "461538.724039275s"
  let totalMs = 0;

  // Extract hours
  const hoursMatch = duration.match(/(\d+)h/);
  if (hoursMatch) {
    totalMs += parseInt(hoursMatch[1], 10) * 60 * 60 * 1000;
  }

  // Extract minutes
  const minutesMatch = duration.match(/(\d+)m(?!s)/);
  if (minutesMatch) {
    totalMs += parseInt(minutesMatch[1], 10) * 60 * 1000;
  }

  // Extract seconds (with optional decimal)
  const secondsMatch = duration.match(/([\d.]+)s/);
  if (secondsMatch) {
    totalMs += parseFloat(secondsMatch[1]) * 1000;
  }

  return totalMs > 0 ? totalMs : null;
}

/**
 * Parse Antigravity rate limit error response to extract retry info
 */
export function parseRateLimitError(errorBody: unknown): {
  retryAfterMs: number;
  model?: string;
  message?: string;
} | null {
  if (!errorBody || typeof errorBody !== "object") return null;

  const body = errorBody as Record<string, unknown>;
  const error = body.error as Record<string, unknown> | undefined;

  if (!error) return null;

  const message = error.message as string | undefined;
  let model: string | undefined;
  let retryAfterMs: number | null = null;

  // Try to extract from details array
  const details = error.details as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(details)) {
    for (const detail of details) {
      // Look for ErrorInfo with quota metadata
      if (detail["@type"]?.toString().includes("ErrorInfo")) {
        const metadata = detail.metadata as Record<string, unknown> | undefined;
        if (metadata) {
          model = metadata.model as string | undefined;
          const quotaResetDelay = metadata.quotaResetDelay as string | undefined;
          if (quotaResetDelay) {
            retryAfterMs = parseDurationToMs(quotaResetDelay);
          }
        }
      }

      // Look for RetryInfo
      if (detail["@type"]?.toString().includes("RetryInfo")) {
        const retryDelay = detail.retryDelay as string | undefined;
        if (retryDelay && retryAfterMs === null) {
          retryAfterMs = parseDurationToMs(retryDelay);
        }
      }
    }
  }

  // Default to 1 hour if we couldn't parse
  if (retryAfterMs === null) {
    retryAfterMs = 60 * 60 * 1000; // 1 hour default
  }

  return {
    retryAfterMs,
    model,
    message,
  };
}

/**
 * Clear all rate limits (useful for testing)
 */
export function clearAllRateLimits(): void {
  rateLimits.clear();
}

/**
 * Compute exponential backoff delay in milliseconds
 * @param attempt - The attempt number (1-based)
 * @param baseMs - Base delay in ms (default: 1000)
 * @param maxMs - Maximum delay in ms (default: 1 hour)
 * @returns Delay in milliseconds
 */
export function computeExponentialBackoffMs(
  attempt: number,
  baseMs = 1000,
  maxMs = 3600000
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const multiplier = 2 ** (safeAttempt - 1);
  return Math.min(maxMs, Math.max(0, Math.floor(baseMs * multiplier)));
}

/**
 * Format wait time in human-readable format
 * Examples: "2h30m", "5m12s", "45s"
 * @param ms - Wait time in milliseconds
 * @returns Formatted string
 */
export function formatWaitTimeMs(ms: number): string {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

/**
 * Parse retry-after from HTTP response headers
 * Supports both retry-after-ms and retry-after (seconds) headers
 * @param response - HTTP response
 * @returns Retry delay in milliseconds, or null if not found
 */
export function parseRetryAfterMs(response: Response): number | null {
  const retryAfterMsHeader = response.headers.get("retry-after-ms");
  const retryAfterSecondsHeader = response.headers.get("retry-after");

  if (retryAfterMsHeader) {
    const parsed = parseInt(retryAfterMsHeader, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return Math.min(parsed, 86400000); // Cap at 24 hours
    }
  }

  if (retryAfterSecondsHeader) {
    const parsed = parseInt(retryAfterSecondsHeader, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return Math.min(parsed * 1000, 86400000); // Cap at 24 hours
    }
  }

  return null;
}
