import type { RateLimitRule } from "@opendum/auth";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/redis";

const API_KEY_RATE_LIMIT_PREFIX = "opendum:api-key-rl";

export type ApiKeyRateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
  exceededWindow: string;
  limit: number;
  current: number;
};

type LimitSpec = { window: string; limit: number; label: string; seconds: number };

export async function checkAndIncrementAPIKeyRateLimit(
  redis: OpendumRedis,
  registry: Registry,
  apiKeyId: string,
  model: string,
  alias: string,
  rules: RateLimitRule[]
): Promise<ApiKeyRateLimitResult> {
  const rule = matchRateLimitRule(registry, model, alias, rules);
  if (!rule) return { allowed: true, retryAfterSeconds: 0, exceededWindow: "", limit: 0, current: 0 };

  const limits: LimitSpec[] = [];
  if (rule.perMinute != null) limits.push({ window: "min", limit: rule.perMinute, label: "minute", seconds: 60 });
  if (rule.perHour != null) limits.push({ window: "hour", limit: rule.perHour, label: "hour", seconds: 3600 });
  if (rule.perDay != null) limits.push({ window: "day", limit: rule.perDay, label: "day", seconds: 86400 });
  if (limits.length === 0) return { allowed: true, retryAfterSeconds: 0, exceededWindow: "", limit: 0, current: 0 };

  const keys = limits.map((limit) => apiKeyWindowKey(apiKeyId, rule.target, limit.window, limit.seconds));
  for (let i = 0; i < limits.length; i += 1) {
    const current = Number.parseInt((await redis.get(keys[i])) ?? "0", 10) || 0;
    if (current >= limits[i].limit) {
      const bucket = windowBucket(limits[i].seconds);
      const retryAfter = Math.max(1, Math.trunc(bucket + limits[i].seconds - Math.floor(Date.now() / 1000)));
      return {
        allowed: false,
        retryAfterSeconds: retryAfter,
        exceededWindow: limits[i].label,
        limit: limits[i].limit,
        current,
      };
    }
  }

  for (let i = 0; i < limits.length; i += 1) {
    const count = await redis.incr(keys[i]);
    if (count === 1) await redis.expire(keys[i], limits[i].seconds + 1);
  }
  return { allowed: true, retryAfterSeconds: 0, exceededWindow: "", limit: 0, current: 0 };
}

export function matchRateLimitRule(
  registry: Registry,
  model: string,
  alias: string,
  rules: RateLimitRule[]
): RateLimitRule | null {
  for (const rule of rules) {
    if (rule.targetType !== "model") continue;
    if (rule.target === model || (alias !== "" && rule.target === alias)) return rule;
  }
  let family = registry.modelFamily(model);
  if (!family && alias) family = registry.modelFamily(alias);
  if (family) {
    for (const rule of rules) {
      if (rule.targetType === "family" && rule.target === family) return rule;
    }
  }
  return null;
}

export function apiKeyWindowKey(apiKeyId: string, target: string, window: string, windowSeconds: number): string {
  return `${API_KEY_RATE_LIMIT_PREFIX}:${apiKeyId}:${target}:${window}:${windowBucket(windowSeconds)}`;
}

export function windowBucket(windowSeconds: number): number {
  const now = Math.floor(Date.now() / 1000);
  return now - (now % windowSeconds);
}
