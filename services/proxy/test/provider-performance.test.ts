import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import type { OpendumRedis } from "@opendum/redis";
import type { ProviderAccount } from "@opendum/providers";
import {
  DEFAULT_PROVIDER_PERFORMANCE_CONFIG,
  ProviderPerformance,
  blendMetrics,
  sampleTokensPerSecond,
  scoreProviderMetrics,
  type ProviderRoutingOptions,
  type ProviderScore,
} from "../src/core/health/provider-performance.ts";
import { orderProvidersByPerformance, prioritizeAccounts } from "../src/core/transport/service-helpers.ts";

const config = DEFAULT_PROVIDER_PERFORMANCE_CONFIG;

function scores(entries: Record<string, number>): Map<string, ProviderScore> {
  return new Map(
    Object.entries(entries).map(([provider, score]) => [
      provider,
      { provider, score, ttftMs: score, tokensPerSecond: 0, samples: 5 },
    ])
  );
}

function account(id: string, provider: string, extra: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id, userId: "u", provider, status: "active", lastUsedAt: null, ...extra } as unknown as ProviderAccount;
}

function sequenceRandom(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

describe("provider performance scoring", () => {
  it("computes tokens per second from decode time", () => {
    assert.equal(sampleTokensPerSecond(100, 1100, 500), 500);
    assert.equal(sampleTokensPerSecond(100, 100, 500), 0);
    assert.equal(sampleTokensPerSecond(100, 1100, 0), 0);
  });

  it("rewards lower ttft and higher throughput with a lower score", () => {
    const fast = scoreProviderMetrics({ ttftMs: 200, tokensPerSecond: 100, samples: 1, updatedAt: 0 }, config);
    const slow = scoreProviderMetrics({ ttftMs: 800, tokensPerSecond: 20, samples: 1, updatedAt: 0 }, config);
    assert.ok(fast < slow);
  });

  it("blends samples with an ewma and keeps counters", () => {
    const first = blendMetrics(null, { ttftMs: 100, tokensPerSecond: 50 }, 0.5);
    assert.deepEqual({ ttftMs: first.ttftMs, tokensPerSecond: first.tokensPerSecond, samples: first.samples }, { ttftMs: 100, tokensPerSecond: 50, samples: 1 });
    const second = blendMetrics(first, { ttftMs: 300, tokensPerSecond: 150 }, 0.5);
    assert.equal(second.ttftMs, 200);
    assert.equal(second.tokensPerSecond, 100);
    assert.equal(second.samples, 2);
  });
});

describe("orderProvidersByPerformance", () => {
  const routing: ProviderRoutingOptions = { scores: scores({ fast: 100, medium: 120, slow: 1000 }), bufferRatio: 0.5, explorationRate: 0 };

  it("keeps the static order when no metrics are known", () => {
    const empty: ProviderRoutingOptions = { scores: new Map(), bufferRatio: 0.5, explorationRate: 0.5 };
    assert.deepEqual(orderProvidersByPerformance(["slow", "fast"], ["fast", "slow"], empty), ["fast", "slow"]);
    assert.deepEqual(orderProvidersByPerformance(["slow", "fast"], ["fast", "slow"]), ["fast", "slow"]);
  });

  it("promotes providers inside the buffer ahead of slow ones", () => {
    const ordered = orderProvidersByPerformance(["slow", "medium", "fast"], ["slow", "medium", "fast"], routing, () => 0.99);
    assert.equal(ordered[ordered.length - 1], "slow");
    assert.ok(ordered.indexOf("slow") > ordered.indexOf("medium"));
  });

  it("explores an out-of-buffer provider when the dice says so", () => {
    const explore: ProviderRoutingOptions = { ...routing, explorationRate: 1 };
    const ordered = orderProvidersByPerformance(["fast", "slow"], ["fast", "slow"], explore, sequenceRandom([0, 0]));
    assert.equal(ordered[0], "slow");
  });

  it("keeps unknown providers in the fallback tail", () => {
    const ordered = orderProvidersByPerformance(["unknown", "fast", "slow"], ["unknown", "fast", "slow"], routing, () => 0.99);
    assert.ok(ordered.indexOf("unknown") > ordered.indexOf("fast"));
  });
});

describe("prioritizeAccounts with performance routing", () => {
  it("groups accounts by the performance order and paid-first", () => {
    const routing: ProviderRoutingOptions = { scores: scores({ fast: 100, slow: 1000 }), bufferRatio: 0.5, explorationRate: 0 };
    const accounts = [
      account("slow-1", "slow", { lastUsedAt: new Date(1) }),
      account("fast-free", "fast"),
      account("fast-paid", "fast", { tier: "pro" }),
    ];
    const ordered = prioritizeAccounts(accounts, true, ["slow", "fast"], routing);
    assert.deepEqual(ordered.map((item) => item.id), ["fast-paid", "fast-free", "slow-1"]);
  });
});

function fakeHashRedis(): OpendumRedis {
  const hashes = new Map<string, Map<string, string>>();
  return {
    hGet: async (key: string, field: string) => hashes.get(key)?.get(field) ?? null,
    hSet: async (key: string, field: string, value: string) => {
      const hash = hashes.get(key) ?? new Map<string, string>();
      hash.set(field, value);
      hashes.set(key, hash);
      return 1;
    },
    hGetAll: async (key: string) => Object.fromEntries(hashes.get(key) ?? new Map()),
    expire: async () => true,
  } as unknown as OpendumRedis;
}

describe("ProviderPerformance store", () => {
  it("records samples and exposes scores for a model", async () => {
    const store = new ProviderPerformance(fakeHashRedis(), { ...config, cacheTtlSeconds: 0 });
    await store.record({ provider: "fast", model: "gpt-4o", ttftMs: 200, outputTokens: 500, durationMs: 1200 });
    await store.record({ provider: "slow", model: "gpt-4o", ttftMs: 2000, outputTokens: 50, durationMs: 3000 });

    const result = await store.scoresForModel("gpt-4o");
    assert.equal(result.size, 2);
    assert.ok((result.get("fast")?.score ?? Infinity) < (result.get("slow")?.score ?? Infinity));
    assert.equal(result.get("fast")?.tokensPerSecond, 500);
  });

  it("returns an empty map when there is nothing recorded", async () => {
    const store = new ProviderPerformance(fakeHashRedis(), config);
    assert.equal((await store.scoresForModel("missing")).size, 0);
  });
});

function controlRedis(overrides: Record<string, unknown> = {}): OpendumRedis {
  return {
    hGet: vi.fn(async () => null),
    hSet: vi.fn(async () => 1),
    hGetAll: vi.fn(async () => ({})),
    expire: vi.fn(async () => true),
    ...overrides,
  } as unknown as OpendumRedis;
}

describe("ProviderPerformance edge cases", () => {
  it("skips samples that cannot be measured", async () => {
    const redis = controlRedis();
    const store = new ProviderPerformance(redis, config);
    await store.record({ provider: "p", model: "m", ttftMs: 0, outputTokens: 0, durationMs: 100 });
    assert.equal((redis.hSet as unknown as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });

  it("blends stored metrics", async () => {
    const redis = controlRedis({ hGet: vi.fn(async () => JSON.stringify({ ttftMs: 100, tokensPerSecond: 10, samples: 2, updatedAt: 1 })) });
    const store = new ProviderPerformance(redis, config);
    await store.record({ provider: "p", model: "m", ttftMs: 200, outputTokens: 500, durationMs: 1200 });
    const saved = JSON.parse((redis.hSet as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string) as { samples: number };
    assert.equal(saved.samples, 3);
  });

  it("keeps previous throughput when a sample has none", async () => {
    const redis = controlRedis({ hGet: vi.fn(async () => JSON.stringify({ ttftMs: 100, tokensPerSecond: 10, samples: 1, updatedAt: 1 })) });
    const store = new ProviderPerformance(redis, config);
    await store.record({ provider: "p", model: "m", ttftMs: 50, outputTokens: 0, durationMs: 100 });
    const saved = JSON.parse((redis.hSet as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string) as { tokensPerSecond: number; ttftMs: number };
    assert.equal(saved.tokensPerSecond, 10);
    assert.equal(saved.ttftMs, 85);
  });

  it("treats invalid stored metrics as missing", async () => {
    for (const raw of ["not json", JSON.stringify({ ttftMs: 0, tokensPerSecond: 0 })]) {
      const redis = controlRedis({ hGet: vi.fn(async () => raw) });
      const store = new ProviderPerformance(redis, config);
      await store.record({ provider: "p", model: "m", ttftMs: 120, outputTokens: 100, durationMs: 500 });
      const saved = JSON.parse((redis.hSet as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string) as { ttftMs: number };
      assert.equal(saved.ttftMs, 120);
    }
  });

  it("caches scores and expires them", async () => {
    const cacheable = new ProviderPerformance(controlRedis(), { ...config, cacheTtlSeconds: 10 });
    const first = await cacheable.scoresForModel("m");
    const second = await cacheable.scoresForModel("m");
    assert.equal(first, second);

    const expiring = new ProviderPerformance(controlRedis(), { ...config, cacheTtlSeconds: 0.001 });
    const before = await expiring.scoresForModel("m");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = await expiring.scoresForModel("m");
    assert.notEqual(before, after);
  });

  it("skips invalid scored entries", async () => {
    const redis = controlRedis({
      hGetAll: vi.fn(async () => ({ bad: "nope", good: JSON.stringify({ ttftMs: 100, tokensPerSecond: 10, samples: 1, updatedAt: 1 }) })),
    });
    const store = new ProviderPerformance(redis, { ...config, cacheTtlSeconds: 0 });
    const scores = await store.scoresForModel("m");
    assert.equal(scores.size, 1);
    assert.equal(scores.has("good"), true);
  });

  it("swallows redis errors", async () => {
    const reading = new ProviderPerformance(controlRedis({ hGetAll: vi.fn(async () => { throw new Error("down"); }) }), { ...config, cacheTtlSeconds: 0 });
    assert.equal((await reading.scoresForModel("m")).size, 0);

    const recording = new ProviderPerformance(controlRedis({ hGet: vi.fn(async () => { throw new Error("down"); }) }), config);
    await recording.record({ provider: "p", model: "m", ttftMs: 100, outputTokens: 10, durationMs: 200 });
  });
});
