import { describe, expect, it } from "bun:test";
import { Deferred, Effect } from "effect";

import { TtlCache } from "@opendum/api/web/lib/ttl-cache";

describe("ttl cache", () => {
  it("serves a cached value within the ttl", async () => {
    const cache = new TtlCache<number>(60_000);
    const state = { calls: 0 };
    const run = () => Effect.runPromise(Effect.sync(() => (state.calls += 1)));

    expect(await Effect.runPromise(cache.load("key", run))).toBe(1);
    expect(await Effect.runPromise(cache.load("key", run))).toBe(1);
    expect(state.calls).toBe(1);
  });

  it("recomputes after invalidation", async () => {
    const cache = new TtlCache<number>(60_000);
    const state = { calls: 0 };
    const run = () => Effect.runPromise(Effect.sync(() => (state.calls += 1)));

    await Effect.runPromise(cache.load("key", run));
    cache.invalidate("key");

    expect(await Effect.runPromise(cache.load("key", run))).toBe(2);
  });

  it("shares an in-flight computation between callers", async () => {
    const cache = new TtlCache<number>(60_000);
    const state = { calls: 0 };
    const gate = Effect.runSync(Deferred.make<number>());

    const run = () => {
      state.calls += 1;
      return Effect.runPromise(Deferred.await(gate));
    };

    const first = Effect.runPromise(cache.load("key", run));
    const second = Effect.runPromise(cache.load("key", run));
    Effect.runSync(Deferred.succeed(gate, state.calls));

    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(state.calls).toBe(1);
  });
});
