import { Cache, Duration, Effect, Result } from "effect";
import type { OpendumRedis } from "@opendum/core/redis";
import { parseJson } from "./helpers.js";

export type ProviderPerformanceConfig = {
  sampleTtlSeconds: number;
  cacheTtlSeconds: number;
  ewmaAlpha: number;
  latencyWeight: number;
  speedWeight: number;
  bufferRatio: number;
  explorationRate: number;
};

export const DEFAULT_PROVIDER_PERFORMANCE_CONFIG: ProviderPerformanceConfig = {
  sampleTtlSeconds: 300,
  cacheTtlSeconds: 10,
  ewmaAlpha: 0.3,
  latencyWeight: 1,
  speedWeight: 1,
  bufferRatio: 0.5,
  explorationRate: 0.1,
};

export type ProviderMetrics = {
  ttftMs: number;
  tokensPerSecond: number;
  samples: number;
  updatedAt: number;
};

export type ProviderPerformanceSample = {
  provider: string;
  model: string;
  ttftMs: number;
  outputTokens: number;
  durationMs: number;
};

export type ProviderScore = {
  provider: string;
  score: number;
  ttftMs: number;
  tokensPerSecond: number;
  samples: number;
};

export type ProviderRoutingOptions = {
  scores: Map<string, ProviderScore>;
  bufferRatio: number;
  explorationRate: number;
};

const KEY_PREFIX = "opendum:provider-performance:";

export function providerPerformanceKey(model: string): string {
  return `${KEY_PREFIX}${model.trim().toLowerCase()}`;
}

export function sampleTokensPerSecond(ttftMs: number, durationMs: number, outputTokens: number): number {
  const decodeMs = durationMs - ttftMs;
  if (outputTokens <= 0 || decodeMs <= 0) return 0;
  return (outputTokens * 1000) / decodeMs;
}

export function scoreProviderMetrics(metrics: ProviderMetrics, config: ProviderPerformanceConfig): number {
  let weighted = 0;
  let weight = 0;
  if (metrics.ttftMs > 0 && config.latencyWeight > 0) {
    weighted += config.latencyWeight * metrics.ttftMs;
    weight += config.latencyWeight;
  }
  if (metrics.tokensPerSecond > 0 && config.speedWeight > 0) {
    weighted += config.speedWeight * (1000 / metrics.tokensPerSecond);
    weight += config.speedWeight;
  }
  return weight > 0 ? weighted / weight : Number.NaN;
}

export function parseMetrics(raw: string | null | undefined): ProviderMetrics | null {
  if (!raw) return null;
  const parsedJson = parseJson(raw);
  if (Result.isFailure(parsedJson)) return null;
  const parsedValue = parsedJson.success;
  if (parsedValue === null || typeof parsedValue !== "object") return null;
  const parsed = parsedValue as Partial<ProviderMetrics>;
  const ttftMs = typeof parsed.ttftMs === "number" && Number.isFinite(parsed.ttftMs) ? Math.max(0, parsed.ttftMs) : 0;
  const tokensPerSecond =
    typeof parsed.tokensPerSecond === "number" && Number.isFinite(parsed.tokensPerSecond)
      ? Math.max(0, parsed.tokensPerSecond)
      : 0;
  const samples = typeof parsed.samples === "number" && Number.isFinite(parsed.samples) ? Math.max(0, parsed.samples) : 0;
  const updatedAt = typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0;
  if (ttftMs <= 0 && tokensPerSecond <= 0) return null;
  return { ttftMs, tokensPerSecond, samples, updatedAt };
}

export function blendMetrics(previous: ProviderMetrics | null, sample: { ttftMs: number; tokensPerSecond: number }, alpha: number): ProviderMetrics {
  const blend = (prev: number, next: number): number => {
    if (next <= 0) return prev;
    if (prev <= 0) return next;
    return prev * (1 - alpha) + next * alpha;
  };
  return {
    ttftMs: blend(previous?.ttftMs ?? 0, sample.ttftMs),
    tokensPerSecond: blend(previous?.tokensPerSecond ?? 0, sample.tokensPerSecond),
    samples: (previous?.samples ?? 0) + 1,
    updatedAt: Date.now(),
  };
}

export class ProviderPerformance {
  private readonly redis: OpendumRedis;
  private readonly config: ProviderPerformanceConfig;
  private readonly scoresCache: Cache.Cache<string, Map<string, ProviderScore>>;

  constructor(redis: OpendumRedis, config: ProviderPerformanceConfig = DEFAULT_PROVIDER_PERFORMANCE_CONFIG) {
    this.redis = redis;
    this.config = config;
    this.scoresCache = Effect.runSync(
      Cache.make({
        capacity: 1024,
        timeToLive: config.cacheTtlSeconds > 0 ? Duration.seconds(config.cacheTtlSeconds) : Duration.zero,
        lookup: (key: string) => this.loadScores(key),
      })
    );
  }

  routingOptions(scores: Map<string, ProviderScore>): ProviderRoutingOptions {
    return {
      scores,
      bufferRatio: this.config.bufferRatio,
      explorationRate: this.config.explorationRate,
    };
  }

  record(sample: ProviderPerformanceSample): Effect.Effect<void> {
    const ttftMs = Math.max(0, sample.ttftMs);
    const tokensPerSecond = sampleTokensPerSecond(ttftMs, sample.durationMs, sample.outputTokens);
    if (ttftMs <= 0 && tokensPerSecond <= 0) return Effect.void;
    const key = providerPerformanceKey(sample.model);
    return Effect.gen({ self: this }, function* () {
      const raw = yield* this.redisEffect(() => this.redis.hGet(key, sample.provider));
      const next = blendMetrics(parseMetrics(raw ?? null), { ttftMs, tokensPerSecond }, this.config.ewmaAlpha);
      yield* this.redisEffect(() => this.redis.hSet(key, sample.provider, JSON.stringify(next)));
      yield* this.redisEffect(() => this.redis.expire(key, this.config.sampleTtlSeconds));
      yield* Cache.invalidate(this.scoresCache, key);
    }).pipe(
      Effect.tapError((error) => Effect.logDebug("provider performance sample dropped", { error, provider: sample.provider })),
      Effect.ignore
    );
  }

  scoresForModel(model: string): Effect.Effect<Map<string, ProviderScore>> {
    return Cache.get(this.scoresCache, providerPerformanceKey(model)).pipe(
      Effect.orElseSucceed(() => new Map<string, ProviderScore>())
    );
  }

  private loadScores(key: string): Effect.Effect<Map<string, ProviderScore>> {
    return Effect.gen({ self: this }, function* () {
      const entries = yield* this.redisEffect(() => this.redis.hGetAll(key)).pipe(Effect.orElseSucceed(() => ({})));
      const scores = new Map<string, ProviderScore>();
      for (const [provider, raw] of Object.entries(entries ?? {})) {
        const metrics = parseMetrics(raw);
        if (!metrics) continue;
        scores.set(provider, {
          provider,
          score: scoreProviderMetrics(metrics, this.config),
          ttftMs: metrics.ttftMs,
          tokensPerSecond: metrics.tokensPerSecond,
          samples: metrics.samples,
        });
      }
      return scores;
    });
  }

  private redisEffect<A>(run: () => Promise<A>): Effect.Effect<A, Error> {
    return Effect.tryPromise({
      try: run,
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
  }
}
