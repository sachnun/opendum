/**
 * Provider latency tracking.
 *
 * Stores historical TTFB (time-to-first-byte) samples per provider+model
 * combination in Redis for observability and future analysis.
 */

import { getRedisClient } from "../redis.js";

/** Redis key prefix for latency sorted sets. */
const LATENCY_KEY_PREFIX = "opendum:latency";

/** Maximum number of latency samples retained per key. */
const MAX_SAMPLES = 100;

/** TTL for latency keys (seconds). Stale data auto-expires. */
const LATENCY_TTL_SECONDS = 86_400; // 24 hours

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
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return;

  try {
    const redis = await getRedisClient();
    const key = buildKey(provider, model, isStream);

    // Use timestamp as score so we can trim oldest entries.
    // The member encodes the latency value to avoid collisions.
    const now = Date.now();
    const member = `${latencyMs}:${now}`;

    await redis.zadd(key, now, member);

    // Trim to keep only the most recent MAX_SAMPLES entries (by score = timestamp).
    const count = await redis.zcard(key);
    if (count > MAX_SAMPLES) {
      await redis.zremrangebyrank(key, 0, count - MAX_SAMPLES - 1);
    }

    // Refresh TTL so the key doesn't expire while still actively used.
    await redis.expire(key, LATENCY_TTL_SECONDS);
  } catch {
    // Swallow – latency tracking must never break the request path.
  }
}
