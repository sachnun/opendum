import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { hashString } from "@opendum/core/crypto";
import type { Registry } from "@opendum/models/runtime";
import {
  type Cache,
  type Cached,
  INVALID_TTL,
  VALID_TTL,
} from "../cache.js";
import { Keys, type Queries } from "../keys.js";

type KeyRow = {
  id: string;
  userId: string;
  isActive: boolean;
  expiresAt: Date | null;
  modelAccessMode: string;
  modelAccessList: string[];
  accountAccessMode: string;
  accountAccessList: string[];
  roamingEnabled: boolean;
};

type RateLimitRow = {
  target: string;
  targetType: string;
  perMinute: number | null;
  perHour: number | null;
  perDay: number | null;
};

function rowOf(overrides: Partial<KeyRow> = {}): KeyRow {
  return {
    id: "key-1",
    userId: "user-1",
    isActive: true,
    expiresAt: null,
    modelAccessMode: "all",
    modelAccessList: [],
    accountAccessMode: "all",
    accountAccessList: [],
    roamingEnabled: false,
    ...overrides,
  };
}

function registryOf(aliases: Record<string, string> = {}): Registry {
  const canonical = new Set(Object.values(aliases));
  return {
    resolveAlias: (model: string) => aliases[model] ?? model,
    isSupported: (model: string) => canonical.has(model) || model in aliases,
  } as unknown as Registry;
}

function cacheOf(cached: Cached | null = null): {
  cache: Cache;
  touched: string[];
  invalidated: Array<{ keyHash: string; apiKeyId: string }>;
  sets: Array<{ keyHash: string; value: Cached; ttl: number }>;
} {
  const touched: string[] = [];
  const invalidated: Array<{ keyHash: string; apiKeyId: string }> = [];
  const sets: Array<{ keyHash: string; value: Cached; ttl: number }> = [];
  let current = cached;
  const cache = {
    get: () => Effect.succeed(current),
    set: (keyHash: string, value: Cached, ttl: number) =>
      Effect.sync(() => {
        sets.push({ keyHash, value, ttl });
        current = value;
      }),
    touch: (apiKeyId: string) =>
      Effect.sync(() => {
        touched.push(apiKeyId);
      }),
    invalidate: (keyHash: string, apiKeyId: string) =>
      Effect.sync(() => {
        invalidated.push({ keyHash, apiKeyId });
      }),
  } as unknown as Cache;
  return { cache, touched, invalidated, sets };
}

function queriesOf(row: KeyRow | null, rateLimits: RateLimitRow[] = []): Queries {
  return {
    keyByHash: () => Effect.succeed(row),
    deactivateAPIKey: () => Effect.succeed(undefined),
    rateLimits: () => Effect.succeed(rateLimits),
  } as unknown as Queries;
}

function validatorOf(options: {
  cache: Cache;
  row?: KeyRow | null;
  rateLimits?: RateLimitRow[];
  aliases?: Record<string, string>;
}): Keys {
  return new Keys({
    registry: registryOf(options.aliases),
    keyCache: options.cache,
    queries: queriesOf(options.row ?? null, options.rateLimits),
  });
}

describe("Keys", () => {
  it("rejects missing authorization headers", async () => {
    const { cache } = cacheOf();
    const validator = validatorOf({ cache });

    const result = await Effect.runPromise(validator.validate("   "));

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Missing Authorization header");
  });

  it("returns cached invalid results", async () => {
    const { cache } = cacheOf({ valid: false, error: "API key has been revoked" });
    const validator = validatorOf({ cache });

    const result = await Effect.runPromise(validator.validate("Bearer token"));

    expect(result.valid).toBe(false);
    expect(result.error).toBe("API key has been revoked");
  });

  it("returns cached valid results with normalization", async () => {
    const cached: Cached = {
      valid: true,
      userId: "user-1",
      apiKeyId: "key-1",
      modelAccessMode: "whitelist",
      modelAccessList: ["canonical-fast"],
      accountAccessMode: "blacklist",
      accountAccessList: ["acc-1"],
      roamingEnabled: true,
      rateLimitRules: [{ target: "gpt", targetType: "family", perMinute: 1, perHour: null, perDay: null }],
    };
    const { cache } = cacheOf(cached);
    const validator = validatorOf({ cache, aliases: { fast: "canonical-fast" } });

    const result = await Effect.runPromise(validator.validate("Bearer token"));

    expect(result).toMatchObject({
      valid: true,
      userId: "user-1",
      apiKeyId: "key-1",
      modelAccessMode: "whitelist",
      modelAccessList: ["canonical-fast"],
      accountAccessMode: "blacklist",
      accountAccessList: ["acc-1"],
      roamingEnabled: true,
    });
    expect(result.rateLimitRules).toEqual([
      { target: "gpt", targetType: "family", perMinute: 1, perHour: null, perDay: null },
    ]);
  });

  it("invalidates expired cache entries and falls back to the database", async () => {
    const expired: Cached = {
      valid: true,
      userId: "user-1",
      apiKeyId: "key-1",
      expiresAtMs: Date.now() - 1000,
    };
    const { cache, invalidated, sets } = cacheOf(expired);
    const validator = validatorOf({ cache, row: null });

    const result = await Effect.runPromise(validator.validate("Bearer token"));

    expect(invalidated).toEqual([{ keyHash: hashString("token"), apiKeyId: "key-1" }]);
    expect(result.error).toBe("Invalid API key");
    expect(sets[0].ttl).toBe(INVALID_TTL);
  });

  it("rejects revoked keys and caches the failure", async () => {
    const { cache, sets } = cacheOf();
    const validator = validatorOf({ cache, row: rowOf({ isActive: false }) });

    const result = await Effect.runPromise(validator.validate("Bearer token"));

    expect(result.error).toBe("API key has been revoked");
    expect(sets[0].value).toMatchObject({
      valid: false,
      apiKeyId: "key-1",
      error: "API key has been revoked",
    });
    expect(sets[0].ttl).toBe(INVALID_TTL);
  });

  it("rejects expired keys and caches the failure", async () => {
    const { cache, sets } = cacheOf();
    const validator = validatorOf({ cache, row: rowOf({ expiresAt: new Date(Date.now() - 1000) }) });

    const result = await Effect.runPromise(validator.validate("Bearer token"));

    expect(result.error).toBe("API key has expired");
    expect(sets[0].value.error).toBe("API key has expired");
  });

  it("returns fresh results with normalized access and rate limits", async () => {
    const { cache, sets } = cacheOf();
    const validator = validatorOf({
      cache,
      row: rowOf({
        modelAccessMode: "whitelist",
        modelAccessList: ["fast"],
        accountAccessMode: "nonsense",
        accountAccessList: [" acc-1 ", "acc-1"],
      }),
      rateLimits: [
        { target: "gpt", targetType: "family", perMinute: 2, perHour: null, perDay: null },
        { target: "m", targetType: "model", perMinute: null, perHour: 3, perDay: null },
        { target: "x", targetType: "other", perMinute: null, perHour: null, perDay: 4 },
      ],
      aliases: { fast: "canonical-fast" },
    });

    const result = await Effect.runPromise(validator.validate("Bearer token"));

    expect(result).toMatchObject({
      valid: true,
      userId: "user-1",
      apiKeyId: "key-1",
      modelAccessMode: "whitelist",
      modelAccessList: ["canonical-fast"],
      accountAccessMode: "all",
      accountAccessList: ["acc-1"],
    });
    expect(result.rateLimitRules).toEqual([
      { target: "gpt", targetType: "family", perMinute: 2, perHour: null, perDay: null },
      { target: "m", targetType: "model", perMinute: null, perHour: 3, perDay: null },
      { target: "x", targetType: "model", perMinute: null, perHour: null, perDay: 4 },
    ]);
    expect(sets[0].ttl).toBe(VALID_TTL);
    expect(sets[0].value).toMatchObject({
      valid: true,
      userId: "user-1",
      apiKeyId: "key-1",
      modelAccessList: ["canonical-fast"],
    });
  });

  it("caps the cache ttl at the key expiry", async () => {
    const { cache, sets } = cacheOf();
    const validator = validatorOf({ cache, row: rowOf({ expiresAt: new Date(Date.now() + 5000) }) });

    await Effect.runPromise(validator.validate("Bearer token"));

    expect(sets[0].ttl).toBeGreaterThan(0);
    expect(sets[0].ttl).toBeLessThanOrEqual(5);
    expect(sets[0].value.expiresAtMs).toBeGreaterThan(Date.now());
  });
});
