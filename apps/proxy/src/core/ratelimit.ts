import type Redis from "ioredis";
import type { RateLimitRule } from "../auth/types.js";

const apiKeyRateLimitPrefix = "opendum:api-key-rl";

export interface APIKeyRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  exceededWindow: string;
  limit: number;
  current: number;
}

const apiKeyRateLimitLua = `
local n = tonumber(ARGV[1])
for i = 1, n do
  local offset = (i - 1) * 3
  local limit = tonumber(ARGV[2 + offset])
  local current = tonumber(redis.call('GET', KEYS[i]) or '0') or 0
  if current >= limit then
    return {0, i, current}
  end
end
for i = 1, n do
  local offset = (i - 1) * 3
  local ttl = tonumber(ARGV[3 + offset])
  local count = redis.call('INCR', KEYS[i])
  if count == 1 then
    redis.call('EXPIRE', KEYS[i], ttl)
  end
end
return {1}
`;

export async function checkAndIncrementAPIKeyRateLimit(
  redis: Redis | null,
  apiKeyID: string,
  model: string,
  rules: RateLimitRule[],
  modelFamily: string,
): Promise<APIKeyRateLimitResult> {
  const rule = matchRateLimitRule(model, rules, modelFamily);
  if (!rule) return { allowed: true, retryAfterSeconds: 0, exceededWindow: "", limit: 0, current: 0 };

  interface LimitSpec {
    window: string;
    limit: number;
    label: string;
    secs: number;
  }
  const limits: LimitSpec[] = [];
  if (rule.perMinute !== undefined && rule.perMinute !== null) {
    limits.push({ window: "min", limit: rule.perMinute, label: "minute", secs: 60 });
  }
  if (rule.perHour !== undefined && rule.perHour !== null) {
    limits.push({ window: "hour", limit: rule.perHour, label: "hour", secs: 3600 });
  }
  if (rule.perDay !== undefined && rule.perDay !== null) {
    limits.push({ window: "day", limit: rule.perDay, label: "day", secs: 86400 });
  }
  if (limits.length === 0) return { allowed: true, retryAfterSeconds: 0, exceededWindow: "", limit: 0, current: 0 };
  if (!redis) return { allowed: true, retryAfterSeconds: 0, exceededWindow: "", limit: 0, current: 0 };

  const keys: string[] = [];
  const args: Array<string | number> = [limits.length];
  for (const limit of limits) {
    keys.push(apiKeyWindowKey(apiKeyID, rule.target, limit.window, limit.secs));
    args.push(limit.limit, limit.secs + 1, limit.label);
  }

  let result: Array<unknown>;
  try {
    result = (await redis.eval(apiKeyRateLimitLua, keys.length, ...keys, ...args)) as Array<unknown>;
  } catch {
    return { allowed: true, retryAfterSeconds: 0, exceededWindow: "", limit: 0, current: 0 };
  }
  if (result.length > 0 && toInt(result[0]) === 1) {
    return { allowed: true, retryAfterSeconds: 0, exceededWindow: "", limit: 0, current: 0 };
  }
  const idx = toInt(result[1]) - 1;
  if (idx < 0 || idx >= limits.length) {
    return { allowed: true, retryAfterSeconds: 0, exceededWindow: "", limit: 0, current: 0 };
  }
  const exceeded = limits[idx]!;
  const bucket = windowBucket(exceeded.secs);
  const retryAfter = Math.max(1, bucket + exceeded.secs - Math.floor(Date.now() / 1000));
  return { allowed: false, retryAfterSeconds: retryAfter, exceededWindow: exceeded.label, limit: exceeded.limit, current: toInt(result[2]) };
}

function matchRateLimitRule(model: string, rules: RateLimitRule[], family: string): RateLimitRule | null {
  for (const rule of rules) {
    if (rule.targetType === "model" && rule.target === model) return rule;
  }
  if (family !== "") {
    for (const rule of rules) {
      if (rule.targetType === "family" && rule.target === family) return rule;
    }
  }
  return null;
}

function apiKeyWindowKey(apiKeyID: string, target: string, window: string, windowSeconds: number): string {
  return `${apiKeyRateLimitPrefix}:${apiKeyID}:${target}:${window}:${windowBucket(windowSeconds)}`;
}

function windowBucket(windowSeconds: number): number {
  const now = Math.floor(Date.now() / 1000);
  return now - (now % windowSeconds);
}

function toInt(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}
