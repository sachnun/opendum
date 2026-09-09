import { getRedisClient } from "../redis.js";
import { inferModelFamily } from "@opendum/ai";

const RATE_LIMIT_KEY_PREFIX = "opendum:api-key-rl";

const RATE_LIMIT_SCRIPT = `
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
    rules: ApiKeyRateLimitRule[],
): ApiKeyRateLimitRule | null {
    const modelRule = rules.find(
        (r) => r.targetType === "model" && r.target === model,
    );
    if (modelRule) return modelRule;

    const family = inferModelFamily(model);
    const familyRule = rules.find(
        (r) => r.targetType === "family" && r.target === family,
    );
    return familyRule ?? null;
}

export async function checkAndIncrementRateLimit(
    apiKeyId: string,
    model: string,
    rules: ApiKeyRateLimitRule[],
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
    const windows = [
        { name: "min" as const, label: "minute", limit: rule.perMinute },
        { name: "hour" as const, label: "hour", limit: rule.perHour },
        { name: "day" as const, label: "day", limit: rule.perDay },
    ].filter(
        (window): window is { name: Window; label: string; limit: number } =>
            window.limit !== null && window.limit !== undefined,
    );
    if (windows.length === 0) return { allowed: true };

    const keys: string[] = [];
    const args: string[] = [String(windows.length)];
    for (const { name, label, limit } of windows) {
        const duration = WINDOW_SECONDS[name];
        const bucket = now - (now % duration);
        keys.push(
            `${RATE_LIMIT_KEY_PREFIX}:${apiKeyId}:${rule.target}:${name}:${bucket}`,
        );
        args.push(String(limit), String(duration + 1), label);
    }

    try {
        const raw = await redis.eval(RATE_LIMIT_SCRIPT, {
            keys,
            arguments: args,
        });
        const result = Array.isArray(raw) ? raw.map(Number) : [];
        if (result[0] === 1) return { allowed: true };

        const index = (result[1] ?? 0) - 1;
        const exceeded = windows[index];
        if (!exceeded) return { allowed: true };
        const duration = WINDOW_SECONDS[exceeded.name];
        const bucket = now - (now % duration);
        return {
            allowed: false,
            retryAfterSeconds: Math.max(1, bucket + duration - now),
            exceededWindow: exceeded.label,
            limit: exceeded.limit,
            current: result[2] ?? 0,
        };
    } catch {
        return { allowed: true };
    }
}
