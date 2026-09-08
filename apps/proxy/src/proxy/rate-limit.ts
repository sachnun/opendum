import { getRedisClient } from "../redis.js";

interface RateLimitEntry {
  resetTime: number;
  model?: string;
  message?: string;
}

export type RateLimitScope = string;

const RATE_LIMIT_KEY_PREFIX = "opendum:rate-limit";
const MAX_RETRY_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

function getRateLimitKey(accountId: string, scope: RateLimitScope): string {
  return `${RATE_LIMIT_KEY_PREFIX}:${accountId}:${scope}`;
}

export function getRateLimitScope(model: string): RateLimitScope {
  return model.trim().toLowerCase();
}

export function parseRetryAfterMs(
  headerValue: string | null | undefined
): number | null {
  if (!headerValue) return null;

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS);
  }

  const parsedDate = Date.parse(headerValue);
  if (!Number.isNaN(parsedDate)) {
    const diff = parsedDate - Date.now();
    return Math.min(Math.max(0, diff), MAX_RETRY_AFTER_MS);
  }

  return null;
}

export async function isRateLimited(
  accountId: string,
  scope: RateLimitScope
): Promise<{ rateLimited: boolean; resetTime?: number; message?: string }> {
  const redis = await getRedisClient();
  if (!redis) return { rateLimited: false };
  const key = getRateLimitKey(accountId, scope);
  const raw = await redis.get(key);

  if (!raw) {
    return { rateLimited: false };
  }

  try {
    const parsed: RateLimitEntry = JSON.parse(raw);
    const now = Date.now();
    if (parsed.resetTime > now) {
      return {
        rateLimited: true,
        resetTime: parsed.resetTime,
        message: parsed.message,
      };
    }
  } catch {
    // ignore corrupted JSON
  }

  return { rateLimited: false };
}

export async function markRateLimited(
  accountId: string,
  scope: RateLimitScope,
  retryAfterMs: number,
  model?: string,
  message?: string
): Promise<void> {
  const redis = await getRedisClient();
  if (!redis) return;
  const key = getRateLimitKey(accountId, scope);
  const resetTime = Date.now() + Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  const ttlSeconds = Math.ceil(retryAfterMs / 1000);

  const entry: RateLimitEntry = {
    resetTime,
    model,
    message: message?.slice(0, 500),
  };

  await redis.set(key, JSON.stringify(entry), { EX: Math.max(1, ttlSeconds) });
}
