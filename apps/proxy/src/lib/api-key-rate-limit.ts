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

/**
 * Get the current fixed-window bucket timestamp (floored to window boundary).
 * Including the bucket in the Redis key ensures counters reset at window
 * boundaries without relying on TTL resets.
 */
function getWindowBucket(window: Window): number {
  const now = Math.floor(Date.now() / 1000);
  return now - (now % WINDOW_SECONDS[window]);
}

function getWindowKey(
  apiKeyId: string,
  target: string,
  window: Window
): string {
  const bucket = getWindowBucket(window);
  return `${RATE_LIMIT_KEY_PREFIX}:${apiKeyId}:${target}:${window}:${bucket}`;
}

/**
 * Lua script for atomic check-and-increment across multiple windows.
 *
 * KEYS: one Redis key per window
 * ARGV: [numWindows, limit1, ttl1, label1, limit2, ttl2, label2, ...]
 *
 * Returns an array:
 *   [1]            -- 1 = allowed, 0 = denied
 *   [2] (if denied) -- index (1-based) of the exceeded window
 *   [3] (if denied) -- current count in the exceeded window
 */
const RATE_LIMIT_LUA = `
local n = tonumber(ARGV[1])

-- Phase 1: check all windows
for i = 1, n do
  local offset = (i - 1) * 3
  local limit = tonumber(ARGV[2 + offset])
  local current = tonumber(redis.call('GET', KEYS[i]) or '0') or 0
  if current >= limit then
    return {0, i, current}
  end
end

-- Phase 2: all windows OK, increment all counters
for i = 1, n do
  local offset = (i - 1) * 3
  local ttl = tonumber(ARGV[3 + offset])
  local count = redis.call('INCR', KEYS[i])
  -- Only set expiry when the key is first created (count == 1)
  -- so the window boundary stays fixed.
  if count == 1 then
    redis.call('EXPIRE', KEYS[i], ttl)
  end
end

return {1}
`;

/**
 * Check rate limits for an API key + model combination.
 * Uses a Lua script for atomic check-and-increment to prevent race conditions.
 * Keys include a bucket timestamp for fixed-window semantics.
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

  // Build KEYS and ARGV for the Lua script
  const keys = limits.map((l) => getWindowKey(apiKeyId, target, l.window));

  // ARGV: [numWindows, limit1, ttl1, label1, limit2, ttl2, label2, ...]
  // Labels are not used inside Lua but we keep the structure aligned;
  // Lua only reads limit and ttl.  We add +1 to the TTL so the key
  // stays around briefly past the window boundary (avoids edge-case
  // where the key expires a tick before the window ends).
  const argv: (string | number)[] = [limits.length];
  for (const l of limits) {
    argv.push(l.limit, WINDOW_SECONDS[l.window] + 1, l.label);
  }

  const result = (await redis.eval(
    RATE_LIMIT_LUA,
    keys.length,
    ...keys,
    ...argv
  )) as number[];

  if (result[0] === 1) {
    return { allowed: true };
  }

  // Denied -- result = [0, windowIndex (1-based), currentCount]
  const exceededIdx = result[1] - 1;
  const current = result[2];
  const exceeded = limits[exceededIdx];

  // Calculate retry time based on the fixed window boundary
  const bucket = getWindowBucket(exceeded.window);
  const windowEnd = bucket + WINDOW_SECONDS[exceeded.window];
  const now = Math.floor(Date.now() / 1000);
  const retryAfterSeconds = Math.max(1, windowEnd - now);

  return {
    allowed: false,
    retryAfterSeconds,
    exceededWindow: exceeded.label,
    limit: exceeded.limit,
    current,
  };
}
