import type { OpendumRedis } from "@opendum/redis";

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
  try {
    const parsed = JSON.parse(raw) as Partial<ProviderMetrics>;
    const ttftMs = typeof parsed.ttftMs === "number" && Number.isFinite(parsed.ttftMs) ? Math.max(0, parsed.ttftMs) : 0;
    const tokensPerSecond =
      typeof parsed.tokensPerSecond === "number" && Number.isFinite(parsed.tokensPerSecond)
        ? Math.max(0, parsed.tokensPerSecond)
        : 0;
    const samples = typeof parsed.samples === "number" && Number.isFinite(parsed.samples) ? Math.max(0, parsed.samples) : 0;
    const updatedAt = typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0;
    if (ttftMs <= 0 && tokensPerSecond <= 0) return null;
    return { ttftMs, tokensPerSecond, samples, updatedAt };
  } catch {
    return null;
  }
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

type CacheEntry = { at: number; scores: Map<string, ProviderScore> };

export class ProviderPerformance {
  private readonly redis: OpendumRedis;
  private readonly config: ProviderPerformanceConfig;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(redis: OpendumRedis, config: ProviderPerformanceConfig = DEFAULT_PROVIDER_PERFORMANCE_CONFIG) {
    this.redis = redis;
    this.config = config;
  }

  routingOptions(scores: Map<string, ProviderScore>): ProviderRoutingOptions {
    return {
      scores,
      bufferRatio: this.config.bufferRatio,
      explorationRate: this.config.explorationRate,
    };
  }

  async record(sample: ProviderPerformanceSample): Promise<void> {
    const ttftMs = Math.max(0, sample.ttftMs);
    const tokensPerSecond = sampleTokensPerSecond(ttftMs, sample.durationMs, sample.outputTokens);
    if (ttftMs <= 0 && tokensPerSecond <= 0) return;
    const key = providerPerformanceKey(sample.model);
    try {
      const previous = parseMetrics(await this.redis.hGet(key, sample.provider));
      const next = blendMetrics(previous, { ttftMs, tokensPerSecond }, this.config.ewmaAlpha);
      await this.redis.hSet(key, sample.provider, JSON.stringify(next));
      await this.redis.expire(key, this.config.sampleTtlSeconds);
      this.cache.delete(key);
    } catch {
      return;
    }
  }

  async scoresForModel(model: string): Promise<Map<string, ProviderScore>> {
    const key = providerPerformanceKey(model);
    const cached = this.cachedScores(key);
    if (cached) return cached;
    const scores = new Map<string, ProviderScore>();
    try {
      const entries = await this.redis.hGetAll(key);
      for (const [provider, raw] of Object.entries(entries)) {
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
    } catch {
      return scores;
    }
    if (this.config.cacheTtlSeconds > 0) {
      this.cache.set(key, { at: Date.now(), scores });
    }
    return scores;
  }

  private cachedScores(key: string): Map<string, ProviderScore> | null {
    if (this.config.cacheTtlSeconds <= 0) return null;
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at >= this.config.cacheTtlSeconds * 1000) {
      this.cache.delete(key);
      return null;
    }
    return entry.scores;
  }
}
