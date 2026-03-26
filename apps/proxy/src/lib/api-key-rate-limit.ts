import { getRedisClient } from "@opendum/shared/redis";
import { getModelFamily } from "@opendum/shared/proxy/models";
import type { RateLimitRule } from "@opendum/shared";

const RATE_LIMIT_KEY_PREFIX = "opendum:api-key-rl";

type Window = "min" | "hour" | "day";

const WINDOW_SECONDS: Record<Window, number> = {
  min: 60,
  hour: 3600,
  day: 86400,
};

export interface ApiKeyRateLimitResult {
  allowed: boolean;
  /** Seconds until the exceeded window resets */
  retryAfterSeconds?: number;
  /** Which window was exceeded: "minute", "hour", or "day" */
  exceededWindow?: string;
  /** The limit that was exceeded */
  limit?: number;
  /** Current count in the exceeded window */
  current?: number;
}

/**
 * Find the matching rate limit rule for a given model.
 * Priority: exact model match > family match.
 */
function findMatchingRule(
  model: string,
  rules: RateLimitRule[]
): RateLimitRule | null {
  // 1. Exact model match
  const modelRule = rules.find(
    (r) => r.targetType === "model" && r.target === model
  );
  if (modelRule) return modelRule;

  // 2. Family match
  const family = getModelFamily(model);
  if (family) {
    const familyRule = rules.find(
      (r) => r.targetType === "family" && r.target === family
    );
    if (familyRule) return familyRule;
  }

  return null;
}

function getWindowKey(
  apiKeyId: string,
  target: string,
  window: Window
): string {
  return `${RATE_LIMIT_KEY_PREFIX}:${apiKeyId}:${target}:${window}`;
}

/**
 * Get the current window bucket timestamp (floored to window boundary).
 * This is used as part of the sliding window approach:
 * we use a fixed window with the key expiring after the window duration.
 */
function getWindowBucket(window: Window): number {
  const now = Math.floor(Date.now() / 1000);
  return now - (now % WINDOW_SECONDS[window]);
}

/**
 * Check rate limits for an API key + model combination.
 * If allowed, increments the counters atomically.
 * Returns whether the request is allowed.
 */
export async function checkAndIncrementRateLimit(
  apiKeyId: string,
  model: string,
  rules: RateLimitRule[]
): Promise<ApiKeyRateLimitResult> {
  if (rules.length === 0) {
    return { allowed: true };
  }

  const rule = findMatchingRule(model, rules);
  if (!rule) {
    return { allowed: true };
  }

  const limits: { window: Window; limit: number; label: string }[] = [];
  if (rule.perMinute != null) {
    limits.push({ window: "min", limit: rule.perMinute, label: "minute" });
  }
  if (rule.perHour != null) {
    limits.push({ window: "hour", limit: rule.perHour, label: "hour" });
  }
  if (rule.perDay != null) {
    limits.push({ window: "day", limit: rule.perDay, label: "day" });
  }

  if (limits.length === 0) {
    return { allowed: true };
  }

  const redis = await getRedisClient();
  const target = rule.target;

  // Check all windows first
  const keys = limits.map((l) => getWindowKey(apiKeyId, target, l.window));
  const counts = await redis.mget(...keys);

  for (let i = 0; i < limits.length; i++) {
    const current = counts[i] ? parseInt(counts[i]!, 10) : 0;
    if (current >= limits[i].limit) {
      const bucket = getWindowBucket(limits[i].window);
      const windowEnd = bucket + WINDOW_SECONDS[limits[i].window];
      const now = Math.floor(Date.now() / 1000);
      const retryAfterSeconds = Math.max(1, windowEnd - now);

      return {
        allowed: false,
        retryAfterSeconds,
        exceededWindow: limits[i].label,
        limit: limits[i].limit,
        current,
      };
    }
  }

  // All windows OK -- increment all counters atomically via pipeline
  const pipeline = redis.pipeline();
  for (const l of limits) {
    const key = getWindowKey(apiKeyId, target, l.window);
    const ttl = WINDOW_SECONDS[l.window];
    pipeline.incr(key);
    pipeline.expire(key, ttl);
  }
  await pipeline.exec();

  return { allowed: true };
}
