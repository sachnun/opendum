import { Effect, Result } from "effect";
import type { OpendumRedis } from "@opendum/core/redis";
import { modelSaturationKey } from "@opendum/core/redis/keys";
import { tryAsync } from "@opendum/core/best-effort";
import { parseJson, stringValue } from "./helpers.js";

const SATURATION_CODE = 14003;
const SATURATION_MARKERS = ["model busy", "saturated", "模型繁忙", "請求量已飽和", "请求量已饱和"];
const COUNTER_TTL_SECONDS = 300;

export const SATURATION_BASE_DELAY_MS = 1200;
export const SATURATION_MAX_DELAY_MS = 30_000;
export const SATURATION_MAX_WAIT_MS = 5000;
export const SATURATION_MAX_RETRIES = 2;

/**
 * Model saturation is a capacity signal from the upstream for one model, not a
 * credential or account problem. Rotating accounts cannot fix it and throws
 * away the upstream prompt cache, so callers retry the same account instead.
 */
export function isModelSaturated(status: number, body: string): boolean {
  const parsed = parseJson(body.trim());
  if (Result.isSuccess(parsed)) {
    const payload = parsed.success;
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>;
      if (record.code === SATURATION_CODE) return true;
      const text = `${stringValue(record.msg)} ${stringValue(record.message)} ${displayText(record.displayMsg)}`.toLowerCase();
      if (SATURATION_MARKERS.some((marker) => text.includes(marker))) return true;
    }
  }
  if (status !== 429 && status !== 503) return false;
  const lowered = body.toLowerCase();
  return SATURATION_MARKERS.some((marker) => lowered.includes(marker));
}

function displayText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  return Object.values(value as Record<string, unknown>)
    .filter((entry): entry is string => typeof entry === "string")
    .join(" ");
}

export type ModelSaturationOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
};

/**
 * Shared cooldown for one provider and model pair. Every replica reads the same
 * key, so a saturated model parks the whole fleet instead of spending one
 * account after another on a capacity problem.
 */
export class ModelSaturation {
  private readonly redis: OpendumRedis;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;

  constructor(redis: OpendumRedis, options: ModelSaturationOptions = {}) {
    this.redis = redis;
    this.baseDelayMs = Math.max(1, options.baseDelayMs ?? SATURATION_BASE_DELAY_MS);
    this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? SATURATION_MAX_DELAY_MS);
    this.random = options.random ?? Math.random;
  }

  remaining(provider: string, model: string): Effect.Effect<number> {
    return tryAsync(() => this.redis.pTTL(modelSaturationKey(provider, model)), -1).pipe(
      Effect.map((ttl) => (typeof ttl === "number" && ttl > 0 ? ttl : 0))
    );
  }

  hold(provider: string, model: string): Effect.Effect<number> {
    return Effect.gen({ self: this }, function* () {
      const key = modelSaturationKey(provider, model);
      const count = yield* tryAsync(async () => {
        const next = await this.redis.incr(`${key}:strikes`);
        await this.redis.expire(`${key}:strikes`, COUNTER_TTL_SECONDS);
        return next;
      }, 1);
      const exponent = Math.min(Math.max(count - 1, 0), 8);
      const raw = Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
      const delayMs = Math.min(this.maxDelayMs, Math.max(1, Math.trunc(raw * (1 + this.random() * 0.25))));
      yield* tryAsync(() => this.redis.set(key, String(delayMs), { PX: delayMs }), "OK");
      return delayMs;
    });
  }

  clear(provider: string, model: string): Effect.Effect<void> {
    const key = modelSaturationKey(provider, model);
    return tryAsync(() => this.redis.del([key, `${key}:strikes`]), 0).pipe(Effect.asVoid);
  }
}
