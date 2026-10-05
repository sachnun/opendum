import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import {
  analyticsVersionBumpKey,
  analyticsVersionKey,
  apiKeyLastUsedKey,
  apiKeyValidationKey,
  disabledModelsKey,
  type OpendumRedis,
} from "@opendum/redis";
import { mockDatabaseQueries } from "#auth/db-mock.ts";

mockDatabaseQueries();

const {
  bumpAnalyticsCacheVersionThrottled,
  getCachedAPIKeyValidation,
  getCachedDisabledModels,
  resultFromCache,
  setCachedAPIKeyValidation,
  setCachedDisabledModels,
  touchAPIKeyLastUsedThrottled,
} = await import("#auth/cache.ts");

type RedisCall = { op: string; key: string; value?: string; options?: unknown };

function fakeRedis(config: {
  get?: (key: string) => string | null;
  set?: (key: string, value: string, options?: unknown) => string | null;
  incr?: (key: string) => number;
} = {}) {
  const calls: RedisCall[] = [];
  const redis = {
    async get(key: string) {
      calls.push({ op: "get", key });
      return config.get ? config.get(key) : null;
    },
    async set(key: string, value: string, options?: unknown) {
      calls.push({ op: "set", key, value, options });
      return config.set ? config.set(key, value, options) : "OK";
    },
    async incr(key: string) {
      calls.push({ op: "incr", key });
      return config.incr ? config.incr(key) : 0;
    },
    async expire(key: string, seconds: number) {
      calls.push({ op: "expire", key, value: String(seconds) });
      return true;
    },
  };
  return { redis: redis as unknown as OpendumRedis, calls };
}

function fakeRegistry(options: { aliases?: Record<string, string>; supported?: string[] } = {}): Registry {
  const aliases = options.aliases ?? {};
  const supported = new Set(options.supported ?? []);
  return {
    resolveAlias: (model: string) => aliases[model] ?? model,
    isSupported: (model: string) => supported.has(model),
  } as unknown as Registry;
}

describe("resultFromCache", () => {
  it("normalizes cached values", () => {
    assert.deepEqual(
      resultFromCache({
        valid: true,
        userId: "u1",
        apiKeyId: "k1",
        modelAccessMode: "whitelist",
        modelAccessList: [" b ", "a"],
        accountAccessMode: "bogus",
        accountAccessList: [],
        roamingEnabled: true,
      }),
      {
        valid: true,
        userId: "u1",
        apiKeyId: "k1",
        modelAccessMode: "whitelist",
        modelAccessList: ["a", "b"],
        accountAccessMode: "all",
        accountAccessList: [],
        roamingEnabled: true,
        rateLimitRules: [],
        error: "",
      }
    );
  });

  it("fills defaults for an empty cache entry", () => {
    const result = resultFromCache({ valid: true });
    assert.equal(result.userId, "");
    assert.equal(result.modelAccessMode, "all");
    assert.equal(result.roamingEnabled, false);
  });
});

describe("api key validation cache", () => {
  it("reads a cached entry", async () => {
    const { redis } = fakeRedis({ get: (key) => (key === apiKeyValidationKey("h1") ? '{"valid":true,"userId":"u1"}' : null) });
    assert.deepEqual(await getCachedAPIKeyValidation(redis, "h1"), { valid: true, userId: "u1" });
    assert.equal(await getCachedAPIKeyValidation(redis, "missing"), null);
  });

  it("returns null on malformed json", async () => {
    const { redis } = fakeRedis({ get: () => "{not json" });
    assert.equal(await getCachedAPIKeyValidation(redis, "h1"), null);
  });

  it("writes with a rounded ttl of at least one second", async () => {
    const { redis, calls } = fakeRedis();
    await setCachedAPIKeyValidation(redis, "h1", { valid: true }, 0.4);
    assert.deepEqual(calls, [
      { op: "set", key: apiKeyValidationKey("h1"), value: JSON.stringify({ valid: true }), options: { EX: 1 } },
    ]);
  });

  it("swallows write errors", async () => {
    const { redis } = fakeRedis({ set: () => { throw new Error("boom"); } });
    await assert.doesNotReject(setCachedAPIKeyValidation(redis, "h1", { valid: true }, 10));
  });

  it("touches last-used only when the NX key is created", async () => {
    const created = fakeRedis({ set: () => "OK" });
    await assert.doesNotReject(touchAPIKeyLastUsedThrottled(created.redis, "k1"));
    assert.deepEqual(created.calls[0], {
      op: "set",
      key: apiKeyLastUsedKey("k1"),
      value: "1",
      options: { NX: true, EX: 60 },
    });

    const existing = fakeRedis({ set: () => null });
    await assert.doesNotReject(touchAPIKeyLastUsedThrottled(existing.redis, "k1"));

    const blank = fakeRedis();
    await touchAPIKeyLastUsedThrottled(blank.redis, "");
    assert.equal(blank.calls.length, 0);
  });
});

describe("disabled models cache", () => {
  it("reads and normalizes stored models", async () => {
    const registry = fakeRegistry({ aliases: { latest: "gpt-4o" }, supported: ["gpt-4o"] });
    const { redis } = fakeRedis({ get: () => JSON.stringify({ models: ["latest", "unknown"] }) });
    assert.deepEqual(await getCachedDisabledModels(redis, registry, "u1"), ["gpt-4o", "unknown"]);
  });

  it("returns null for missing entries and an empty list for empty payloads", async () => {
    const registry = fakeRegistry();
    assert.equal(await getCachedDisabledModels(fakeRedis().redis, registry, "u1"), null);
    assert.deepEqual(await getCachedDisabledModels(fakeRedis({ get: () => "{}" }).redis, registry, "u1"), []);
    assert.equal(await getCachedDisabledModels(fakeRedis({ get: () => "{bad" }).redis, registry, "u1"), null);
  });

  it("stores a normalized list with a ttl", async () => {
    const registry = fakeRegistry({ supported: ["gpt-4o"] });
    const { redis, calls } = fakeRedis();
    await setCachedDisabledModels(redis, registry, "u1", [" gpt-4o ", "gpt-4o", ""]);
    assert.deepEqual(calls, [
      { op: "set", key: disabledModelsKey("u1"), value: JSON.stringify({ models: ["gpt-4o"] }), options: { EX: 60 } },
    ]);
  });
});

describe("analytics version bump", () => {
  it("increments and sets a ttl on the first bump", async () => {
    const { redis, calls } = fakeRedis({ set: () => "OK", incr: () => 1 });
    await bumpAnalyticsCacheVersionThrottled(redis, "u1");
    assert.deepEqual(calls, [
      { op: "set", key: analyticsVersionBumpKey("u1"), value: "1", options: { NX: true, EX: 15 } },
      { op: "incr", key: analyticsVersionKey("u1") },
      { op: "expire", key: analyticsVersionKey("u1"), value: String(30 * 24 * 60 * 60) },
    ]);
  });

  it("skips the ttl when the version is already set", async () => {
    const { redis, calls } = fakeRedis({ set: () => "OK", incr: () => 5 });
    await bumpAnalyticsCacheVersionThrottled(redis, "u1");
    assert.equal(calls.some((call) => call.op === "expire"), false);
  });

  it("does nothing when throttled or without a user", async () => {
    const throttled = fakeRedis({ set: () => null });
    await bumpAnalyticsCacheVersionThrottled(throttled.redis, "u1");
    assert.equal(throttled.calls.some((call) => call.op === "incr"), false);

    const blank = fakeRedis();
    await bumpAnalyticsCacheVersionThrottled(blank.redis, "");
    assert.equal(blank.calls.length, 0);
  });
});
