import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { OpendumRedis } from "@opendum/core/redis";
import type { ProviderAccount } from "@opendum/providers";
import {
  DEFAULT_CONFIG,
  ProviderPerformance,
  blendMetrics,
  tokenRate,
  scoreMetrics,
  type ProviderRoutingOptions,
  type ProviderScore,
} from "@opendum/api/core/provider-performance";
import { byPerformance, prioritizeAccounts } from "@opendum/api/core/service-helpers";

const config = DEFAULT_CONFIG;

function scores(entries: Record<string, number>): Map<string, ProviderScore> {
  return new Map(
    Object.entries(entries).map(([provider, score]) => [
      provider,
      { provider, score, ttftMs: score, tokenRate: 0, samples: 5 },
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
    expect(tokenRate(100, 1100, 500)).toBe(500);
    expect(tokenRate(100, 100, 500)).toBe(0);
    expect(tokenRate(100, 1100, 0)).toBe(0);
  });

  it("rewards lower ttft and higher throughput with a lower score", () => {
    const fast = scoreMetrics({ ttftMs: 200, tokenRate: 100, samples: 1, updatedAt: 0 }, config);
    const slow = scoreMetrics({ ttftMs: 800, tokenRate: 20, samples: 1, updatedAt: 0 }, config);
    expect(fast < slow).toBeTruthy();
  });

  it("blends samples with an ewma and keeps counters", () => {
    const first = blendMetrics(null, { ttftMs: 100, tokenRate: 50 }, 0.5);
    expect({ ttftMs: first.ttftMs, tokenRate: first.tokenRate, samples: first.samples }).toEqual({ ttftMs: 100, tokenRate: 50, samples: 1 });
    const second = blendMetrics(first, { ttftMs: 300, tokenRate: 150 }, 0.5);
    expect(second.ttftMs).toBe(200);
    expect(second.tokenRate).toBe(100);
    expect(second.samples).toBe(2);
  });
});

describe("byPerformance", () => {
  const routing: ProviderRoutingOptions = { scores: scores({ fast: 100, medium: 120, slow: 1000 }), bufferRatio: 0.5, explorationRate: 0 };

  it("keeps the static order when no metrics are known", () => {
    const empty: ProviderRoutingOptions = { scores: new Map(), bufferRatio: 0.5, explorationRate: 0.5 };
    expect(byPerformance(["slow", "fast"], ["fast", "slow"], empty)).toEqual(["fast", "slow"]);
    expect(byPerformance(["slow", "fast"], ["fast", "slow"])).toEqual(["fast", "slow"]);
  });

  it("promotes providers inside the buffer ahead of slow ones", () => {
    const ordered = byPerformance(["slow", "medium", "fast"], ["slow", "medium", "fast"], routing, () => 0.99);
    expect(ordered[ordered.length - 1]).toBe("slow");
    expect(ordered.indexOf("slow") > ordered.indexOf("medium")).toBeTruthy();
  });

  it("explores an out-of-buffer provider when the dice says so", () => {
    const explore: ProviderRoutingOptions = { ...routing, explorationRate: 1 };
    const ordered = byPerformance(["fast", "slow"], ["fast", "slow"], explore, sequenceRandom([0, 0]));
    expect(ordered[0]).toBe("slow");
  });

  it("keeps unknown providers in the fallback tail", () => {
    const ordered = byPerformance(["unknown", "fast", "slow"], ["unknown", "fast", "slow"], routing, () => 0.99);
    expect(ordered.indexOf("unknown") > ordered.indexOf("fast")).toBeTruthy();
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
    expect(ordered.map((item) => item.id)).toEqual(["fast-paid", "fast-free", "slow-1"]);
  });
});

function hashRedis(): OpendumRedis {
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
    const store = new ProviderPerformance(hashRedis(), { ...config, cacheTtlSeconds: 0 });
    await Effect.runPromise(
      store.record({ provider: "fast", model: "gpt-4o", ttftMs: 200, outputTokens: 500, durationMs: 1200 })
    );
    await Effect.runPromise(
      store.record({ provider: "slow", model: "gpt-4o", ttftMs: 2000, outputTokens: 50, durationMs: 3000 })
    );

    const result = await Effect.runPromise(store.scoresForModel("gpt-4o"));
    expect(result.size).toBe(2);
    expect((result.get("fast")?.score ?? Infinity) < (result.get("slow")?.score ?? Infinity)).toBeTruthy();
    expect(result.get("fast")?.tokenRate).toBe(500);
  });

  it("returns an empty map when there is nothing recorded", async () => {
    const store = new ProviderPerformance(hashRedis(), config);
    expect((await Effect.runPromise(store.scoresForModel("missing"))).size).toBe(0);
  });
});
