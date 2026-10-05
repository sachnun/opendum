import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AntigravityRuntime } from "#providers/providers/antigravity/runtime.ts";
import { SIGNATURE_CACHE_TTL_SECONDS } from "#providers/providers/antigravity/runtime.ts";
import { signatureCacheKey } from "#providers/providers/antigravity/model-config.ts";
import {
  cacheSignature,
  cacheSignaturesFromResponse,
  getCachedSignature,
} from "#providers/providers/antigravity/signature.ts";

function fakeRuntime(options: { failGet?: boolean; failSet?: boolean; noRedis?: boolean } = {}) {
  const store = new Map<string, string>();
  const sets: Array<{ key: string; value: string; options?: { EX?: number } }> = [];
  const redis = {
    async get(key: string) {
      if (options.failGet) throw new Error("redis down");
      return store.get(key) ?? null;
    },
    async set(key: string, value: string, setOptions?: { EX?: number }) {
      if (options.failSet) throw new Error("redis down");
      store.set(key, value);
      sets.push({ key, value, options: setOptions });
      return "OK";
    },
  };
  const runtime = {
    name: "antigravity",
    registry: { providerModelConfig: () => ({ signature_family: "claude" }) },
    transport: {},
    redis: options.noRedis ? null : redis,
  } as unknown as AntigravityRuntime;
  return { runtime, store, sets };
}

describe("getCachedSignature", () => {
  it("returns empty without a usable input", async () => {
    const { runtime } = fakeRuntime();
    assert.equal(await getCachedSignature(runtime, "m", "s1", "think"), "");
    assert.equal(await getCachedSignature(runtime, "m", "", "think"), "");
    assert.equal(await getCachedSignature(runtime, "m", "s1", "   "), "");

    const { runtime: noRedis } = fakeRuntime({ noRedis: true });
    assert.equal(await getCachedSignature(noRedis, "m", "s1", "think"), "");
  });

  it("round-trips a cached signature", async () => {
    const { runtime } = fakeRuntime();
    await cacheSignature(runtime, "m", "s1", "think", "sig-1");
    assert.equal(await getCachedSignature(runtime, "m", "s1", "think"), "sig-1");
  });

  it("returns empty on malformed cache or redis errors", async () => {
    const { runtime, store } = fakeRuntime();
    store.set(signatureCacheKey(runtime, "m", "s1", "think"), "{not json");
    assert.equal(await getCachedSignature(runtime, "m", "s1", "think"), "");

    const { runtime: failing } = fakeRuntime({ failGet: true });
    assert.equal(await getCachedSignature(failing, "m", "s1", "think"), "");
  });
});

describe("cacheSignature", () => {
  it("stores with the signature ttl", async () => {
    const { runtime, sets } = fakeRuntime();
    await cacheSignature(runtime, "m", "s1", " think ", "sig");
    assert.equal(sets.length, 1);
    assert.deepEqual(sets[0]!.options, { EX: SIGNATURE_CACHE_TTL_SECONDS });
    assert.deepEqual(JSON.parse(sets[0]!.value), { signature: "sig" });
  });

  it("skips empty inputs", async () => {
    const { runtime, sets } = fakeRuntime();
    await cacheSignature(runtime, "m", "", "think", "sig");
    await cacheSignature(runtime, "m", "s1", "think", "  ");
    await cacheSignature(runtime, "m", "s1", "   ", "sig");
    assert.equal(sets.length, 0);
  });

  it("swallows write errors", async () => {
    const { runtime } = fakeRuntime({ failSet: true });
    await assert.doesNotReject(cacheSignature(runtime, "m", "s1", "think", "sig"));
  });
});

describe("cacheSignaturesFromResponse", () => {
  it("caches signed thought parts only", async () => {
    const { runtime } = fakeRuntime();
    await cacheSignaturesFromResponse(
      runtime,
      {
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: "why", thoughtSignature: "signed" },
                { thought: true, text: "unsigned" },
                { text: "plain" },
              ],
            },
          },
        ],
      },
      "m",
      "s1"
    );
    assert.equal(await getCachedSignature(runtime, "m", "s1", "why"), "signed");
    assert.equal(await getCachedSignature(runtime, "m", "s1", "unsigned"), "");
    assert.equal(await getCachedSignature(runtime, "m", "s1", "plain"), "");
  });

  it("tolerates a response without candidates", async () => {
    const { runtime } = fakeRuntime();
    await assert.doesNotReject(cacheSignaturesFromResponse(runtime, {}, "m", "s1"));
  });
});
