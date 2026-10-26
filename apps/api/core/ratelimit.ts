import { Duration, Effect, Schedule } from "effect";
import type { RateLimitRule } from "@opendum/auth";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/core/redis";

const LIMIT_PREFIX = "opendum:api-key-rl";

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
  exceededWindow: string;
  limit: number;
  current: number;
};

type LimitSpec = { window: string; limit: number; label: string; seconds: number };

const ALLOWED_RESULT: RateLimitResult = {
  allowed: true,
  retryAfterSeconds: 0,
  exceededWindow: "",
  limit: 0,
  current: 0,
};

const REDIS_RETRY = Schedule.exponential(Duration.millis(20)).pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 2 })
);

function redisCall<A>(run: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: run, catch: (cause) => cause }).pipe(
    Effect.retry({ schedule: REDIS_RETRY })
  );
}

export const checkAndIncrement = Effect.fn("ratelimit.checkAndIncrement")(function* (
  redis: OpendumRedis,
  registry: Registry,
  apiKeyId: string,
  model: string,
  alias: string,
  rules: RateLimitRule[]
) {
  return yield* incrementInner(redis, registry, apiKeyId, model, alias, rules).pipe(
    Effect.catchCause(() => Effect.succeed(ALLOWED_RESULT))
  );
});

const incrementInner = Effect.fnUntraced(function* (
  redis: OpendumRedis,
  registry: Registry,
  apiKeyId: string,
  model: string,
  alias: string,
  rules: RateLimitRule[]
) {
  const rule = matchRule(registry, model, alias, rules);
  if (!rule) return ALLOWED_RESULT;

  const limits: LimitSpec[] = [];
  if (rule.perMinute != null) limits.push({ window: "min", limit: rule.perMinute, label: "minute", seconds: 60 });
  if (rule.perHour != null) limits.push({ window: "hour", limit: rule.perHour, label: "hour", seconds: 3600 });
  if (rule.perDay != null) limits.push({ window: "day", limit: rule.perDay, label: "day", seconds: 86400 });
  if (limits.length === 0) return ALLOWED_RESULT;

  const keys = limits.map((limit) => windowKey(apiKeyId, rule.target, limit.window, limit.seconds));
  const nowSeconds = yield* Effect.map(Effect.clockWith((clock) => clock.currentTimeMillis), (ms) =>
    Math.floor(ms / 1000)
  );

  for (let i = 0; i < limits.length; i += 1) {
    const limit = limits[i]!;
    const raw = yield* redisCall(() => redis.get(keys[i]!));
    const current = Number.parseInt(raw ?? "0", 10) || 0;
    if (current >= limit.limit) {
      const bucket = windowBucket(limit.seconds, nowSeconds);
      const retryAfter = Math.max(1, Math.trunc(bucket + limit.seconds - nowSeconds));
      return {
        allowed: false,
        retryAfterSeconds: retryAfter,
        exceededWindow: limit.label,
        limit: limit.limit,
        current,
      } satisfies RateLimitResult;
    }
  }

  for (let i = 0; i < limits.length; i += 1) {
    const count = yield* redisCall(() => redis.incr(keys[i]!));
    if (count === 1) yield* redisCall(() => redis.expire(keys[i]!, limits[i]!.seconds + 1));
  }
  return ALLOWED_RESULT;
});

export function matchRule(
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

export function windowKey(
  apiKeyId: string,
  target: string,
  window: string,
  windowSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  return `${LIMIT_PREFIX}:${apiKeyId}:${target}:${window}:${windowBucket(windowSeconds, nowSeconds)}`;
}

export function windowBucket(windowSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): number {
  return nowSeconds - (nowSeconds % windowSeconds);
}
