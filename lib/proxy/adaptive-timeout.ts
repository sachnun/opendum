/**
 * Adaptive timeout module.
 *
 * Tracks historical TTFB (time-to-first-byte) latencies per provider+model
 * combination in Redis and computes dynamic timeouts based on the P99
 * percentile of recent samples.
 *
 * When fewer than {@link MIN_SAMPLES_FOR_ADAPTIVE} data points are available
 * the caller-supplied static fallback is returned unchanged, ensuring safe
 * cold-start behaviour.
 */

import { Effect } from "effect";
import { RedisService } from "@/lib/effect/services";
import { RedisError } from "@/lib/effect/errors";
import { runWithInfra } from "@/lib/effect/runtime";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Redis key prefix for latency sorted sets. */
const LATENCY_KEY_PREFIX = "opendum:latency";

/** Maximum number of latency samples retained per key. */
const MAX_SAMPLES = 100;

/** TTL for latency keys (seconds). Stale data auto-expires. */
const LATENCY_TTL_SECONDS = 86_400; // 24 hours

/** Percentile used to derive the adaptive timeout (0–1). */
const PERCENTILE = 0.99; // P99

/** Safety multiplier applied on top of the computed percentile. */
const MULTIPLIER = 1.5;

/** Absolute floor – the adaptive timeout will never go below this. */
const MIN_TIMEOUT_MS = 3_000; // 3 s

/** Absolute ceiling – the adaptive timeout will never exceed this. */
const MAX_TIMEOUT_MS = 60_000; // 60 s

/** Minimum sample count before adaptive mode activates. */
const MIN_SAMPLES_FOR_ADAPTIVE = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildKey(
  provider: string,
  model: string,
  isStream: boolean,
): string {
  const mode = isStream ? "stream" : "nonstream";
  const normalizedModel = model.trim().toLowerCase();
  return `${LATENCY_KEY_PREFIX}:${provider}:${normalizedModel}:${mode}`;
}

/**
 * Compute the value at a given percentile from a **sorted** array of numbers.
 * Uses nearest-rank method.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];

  const rank = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(rank, sorted.length - 1))];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// Effect-based internal operations
// ---------------------------------------------------------------------------

const recordLatencyEffect = (
  provider: string,
  model: string,
  isStream: boolean,
  latencyMs: number,
): Effect.Effect<void, RedisError, RedisService> =>
  Effect.gen(function* () {
    if (!Number.isFinite(latencyMs) || latencyMs <= 0) return;

    const redis = yield* RedisService;
    const key = buildKey(provider, model, isStream);

    const now = Date.now();
    const member = `${latencyMs}:${now}`;

    yield* Effect.tryPromise({
      try: () => redis.zadd(key, now, member),
      catch: (cause) => new RedisError({ cause }),
    });

    const count = yield* Effect.tryPromise({
      try: () => redis.zcard(key),
      catch: (cause) => new RedisError({ cause }),
    });

    if (count > MAX_SAMPLES) {
      yield* Effect.tryPromise({
        try: () => redis.zremrangebyrank(key, 0, count - MAX_SAMPLES - 1),
        catch: (cause) => new RedisError({ cause }),
      });
    }

    yield* Effect.tryPromise({
      try: () => redis.expire(key, LATENCY_TTL_SECONDS),
      catch: (cause) => new RedisError({ cause }),
    });
  });

const getAdaptiveTimeoutEffect = (
  provider: string,
  model: string,
  isStream: boolean,
  fallbackMs: number,
): Effect.Effect<number, RedisError, RedisService> =>
  Effect.gen(function* () {
    const redis = yield* RedisService;
    const key = buildKey(provider, model, isStream);

    const members = yield* Effect.tryPromise({
      try: () => redis.zrange(key, 0, -1),
      catch: (cause) => new RedisError({ cause }),
    });

    if (members.length < MIN_SAMPLES_FOR_ADAPTIVE) {
      return fallbackMs;
    }

    // Extract latency values from "latencyMs:timestamp" members.
    const latencies: number[] = [];
    for (const m of members) {
      const colonIdx = m.indexOf(":");
      if (colonIdx === -1) continue;
      const val = Number(m.slice(0, colonIdx));
      if (Number.isFinite(val) && val > 0) {
        latencies.push(val);
      }
    }

    if (latencies.length < MIN_SAMPLES_FOR_ADAPTIVE) {
      return fallbackMs;
    }

    // Sort ascending for percentile calculation.
    latencies.sort((a, b) => a - b);

    const p99 = percentile(latencies, PERCENTILE);
    const adaptive = Math.round(p99 * MULTIPLIER);

    return clamp(adaptive, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  });

// ---------------------------------------------------------------------------
// Public API — signatures unchanged
// Redis failures are caught and handled as fail-open
// ---------------------------------------------------------------------------

/**
 * Record a successful TTFB latency sample.
 *
 * The sample is stored in a Redis Sorted Set keyed by provider+model+mode.
 * The set is trimmed to {@link MAX_SAMPLES} entries and given a sliding TTL.
 *
 * Failures are silently ignored so this never impacts the request path.
 */
export async function recordLatency(
  provider: string,
  model: string,
  isStream: boolean,
  latencyMs: number,
): Promise<void> {
  return runWithInfra(
    recordLatencyEffect(provider, model, isStream, latencyMs).pipe(
      // Swallow Redis errors — latency tracking must never break the request path.
      Effect.catchTag("RedisError", () => Effect.void)
    )
  );
}

/**
 * Compute an adaptive timeout for a given provider+model+mode.
 *
 * Returns `fallbackMs` when there are fewer than {@link MIN_SAMPLES_FOR_ADAPTIVE}
 * samples available (cold-start / low-traffic routes).
 *
 * Otherwise returns `clamp(P99 * MULTIPLIER, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)`.
 */
export async function getAdaptiveTimeout(
  provider: string,
  model: string,
  isStream: boolean,
  fallbackMs: number,
): Promise<number> {
  return runWithInfra(
    getAdaptiveTimeoutEffect(provider, model, isStream, fallbackMs).pipe(
      // On any Redis failure fall back to the static value.
      Effect.catchTag("RedisError", () => Effect.succeed(fallbackMs))
    )
  );
}
