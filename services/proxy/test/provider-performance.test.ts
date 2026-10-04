import assert from "node:assert/strict";
import { describe, it } from "vitest";
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
} from "../src/core/provider-performance.js";
import { orderProvidersByPerformance, prioritizeAccounts } from "../src/core/service-helpers.js";

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
