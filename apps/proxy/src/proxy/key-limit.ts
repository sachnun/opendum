import { getRedisClient } from "../redis.js";
import { inferModelFamily } from "@opendum/ai";

const RATE_LIMIT_KEY_PREFIX = "opendum:api-key-rl";

type Window = "min" | "hour" | "day";

const WINDOW_SECONDS: Record<Window, number> = {
  min: 60,
  hour: 3600,
  day: 86400,
};

export interface ApiKeyRateLimitRule {
  target: string;
  targetType: "model" | "family";
  perMinute?: number | null;
  perHour?: number | null;
  perDay?: number | null;
}

export interface ApiKeyRateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  exceededWindow?: string;
  limit?: number;
  current?: number;
}

function findMatchingRule(
  model: string,
  rules: ApiKeyRateLimitRule[]
): ApiKeyRateLimitRule | null {
  const modelRule = rules.find(
    (r) => r.targetType === "model" && r.target === model
  );
  if (modelRule) return modelRule;

  const family = inferModelFamily(model);
  const familyRule = rules.find(
    (r) => r.targetType === "family" && r.target === family
  );
  return familyRule ?? null;
}

export async function checkAndIncrementRateLimit(
  apiKeyId: string,
  model: string,
  rules: ApiKeyRateLimitRule[]
): Promise<ApiKeyRateLimitResult> {
  const rule = findMatchingRule(model, rules);
  if (!rule) {
    return { allowed: true };
  }

  const redis = await getRedisClient();
  if (!redis) {
    return { allowed: true };
  }
  const now = Math.floor(Date.now() / 1000);
  const windows: Array<{
    name: Window;
    label: string;
    limit: number | null | undefined;
  }> = [
    { name: "min", label: "minute", limit: rule.perMinute },
    { name: "hour", label: "hour", limit: rule.perHour },
    { name: "day", label: "day", limit: rule.perDay },
  ];

  for (const { name, label, limit } of windows) {
    if (!limit || limit <= 0) continue;

    const windowDuration = WINDOW_SECONDS[name];
    const windowStart = now - (now % windowDuration);
    const key = `${RATE_LIMIT_KEY_PREFIX}:${apiKeyId}:${rule.targetType}:${rule.target}:${name}:${windowStart}`;

    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowDuration * 2);
    }

    if (count > limit) {
      const resetTime = windowStart + windowDuration;
      const retryAfterSeconds = Math.max(1, resetTime - now);

      return {
        allowed: false,
        retryAfterSeconds,
        exceededWindow: label,
        limit,
        current: count,
      };
    }
  }

  return { allowed: true };
}
