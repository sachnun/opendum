import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/core/redis";
import { Policy } from "../policy.js";
import { Availability, type Queries } from "../availability.js";
import type { CustomModels } from "../custom-models.js";

type Options = {
  aliases?: Record<string, string>;
  supported?: string[];
  providerModels?: Record<string, string[]>;
  authless?: Record<string, string[]>;
};

function registryOf(options: Options = {}): Registry {
  const aliases = options.aliases ?? {};
  const supported = new Set(options.supported ?? []);
  const providerModels = options.providerModels ?? {};
  const authless = options.authless ?? {};
  return {
    resolveAlias: (model: string) => aliases[model] ?? model,
    isSupported: (model: string) => supported.has(model),
    authlessModels: () => new Map(Object.entries(authless)),
    models: (provider: string) => providerModels[provider] ?? [],
    allModels: () => Object.values(providerModels).flat(),
    providers: (model: string) =>
      Object.entries(providerModels)
        .filter(([, models]) => models.includes(model))
        .map(([provider]) => provider),
    rule: () => null,
  } as unknown as Registry;
}

function redisOf(): { redis: OpendumRedis; store: Map<string, string> } {
  const store = new Map<string, string>();
  const redis = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
  } as unknown as OpendumRedis;
  return { redis, store };
}

type QueryOptions = {
  disabledByUser?: string[];
  byAccounts?: Array<{ providerAccountId: string; model: string }>;
  byShared?: Array<{ providerAccountId: string; model: string }>;
  accounts?: Array<{ id: string; provider: string; tier: string | null }>;
  sharedAccounts?: Array<{ id: string; provider: string; tier: string | null }>;
};

function queriesOf(options: QueryOptions = {}): {
  queries: Queries;
  calls: { disabledByUser: number };
} {
  const calls = { disabledByUser: 0, byAccounts: 0 };
  const queries = {
    listDisabledModelsByUser: () => {
      calls.disabledByUser += 1;
      return Effect.succeed(options.disabledByUser ?? []);
    },
    listActiveAccountTiers: () => Effect.succeed(options.accounts ?? []),
    listDisabledModelsByAccounts: () => {
      calls.byAccounts += 1;
      return Effect.succeed(
        calls.byAccounts === 1 ? (options.byAccounts ?? []) : (options.byShared ?? [])
      );
    },
    listSharedAccounts: () => Effect.succeed(options.sharedAccounts ?? []),
  } as unknown as Queries;
  return { queries, calls };
}

function customModelsOf(
  aliased: Map<string, Set<string>> = new Map(),
  standalone: Map<string, string[]> = new Map()
): CustomModels {
  return {
    modelSets: () => Effect.succeed({ aliased, standalone }),
  } as unknown as CustomModels;
}

function serviceOf(options: {
  redis: OpendumRedis;
  queries: Queries;
  registry?: Registry;
  customModels?: CustomModels;
}): Availability {
  const registry = options.registry ?? registryOf();
  return new Availability({
    registry,
    redis: options.redis,
    customModels: options.customModels ?? customModelsOf(),
    accessPolicy: new Policy(registry),
    queries: options.queries,
  });
}

describe("Availability", () => {
  it("caches the disabled model set per user", async () => {
    const registry = registryOf({ aliases: { fast: "canonical-fast" }, supported: ["canonical-fast"] });
    const { redis } = redisOf();
    const { queries, calls } = queriesOf({ disabledByUser: ["fast", "model-b"] });
    const service = serviceOf({ registry, redis, queries });

    const first = await Effect.runPromise(service.disabledModels("u1"));
    expect([...first]).toEqual(["canonical-fast", "model-b"]);
    expect(calls.disabledByUser).toBe(1);

    const second = await Effect.runPromise(service.disabledModels("u1"));
    expect([...second]).toEqual(["canonical-fast", "model-b"]);
    expect(calls.disabledByUser).toBe(1);
  });

  it("falls back to the database when redis fails", async () => {
    const failingRedis = {
      get: async () => {
        throw new Error("redis down");
      },
      set: async () => "OK",
    } as unknown as OpendumRedis;
    const { queries, calls } = queriesOf({ disabledByUser: ["m"] });
    const service = serviceOf({ redis: failingRedis, queries });

    const set = await Effect.runPromise(service.disabledModels("u1"));

    expect([...set]).toEqual(["m"]);
    expect(calls.disabledByUser).toBe(1);
  });

  it("resolves aliases when checking a single model", async () => {
    const registry = registryOf({ aliases: { fast: "canonical-fast" } });
    const { redis } = redisOf();
    const { queries } = queriesOf({ disabledByUser: ["canonical-fast"] });
    const service = serviceOf({ registry, redis, queries });

    expect(await Effect.runPromise(service.isDisabled("u1", "fast"))).toBe(true);
    expect(await Effect.runPromise(service.isDisabled("u1", "other"))).toBe(false);
  });

  it("builds account availability from accounts, shared accounts and custom models", async () => {
    const registry = registryOf({
      aliases: { fast: "canonical-fast" },
      supported: ["canonical-fast"],
      providerModels: { p: ["m"], mine: ["canonical-fast"] },
      authless: { opencode: ["oc-model"] },
    });
    const { redis } = redisOf();
    const { queries } = queriesOf({
      accounts: [
        { id: "a1", provider: "p", tier: "Pro" },
        { id: "a2", provider: "p", tier: null },
      ],
      byAccounts: [
        { providerAccountId: "a1", model: "m" },
        { providerAccountId: "a1", model: "fast" },
      ],
      sharedAccounts: [{ id: "s1", provider: "q", tier: "Max" }],
      byShared: [{ providerAccountId: "s1", model: "m" }],
    });
    const service = serviceOf({
      registry,
      redis,
      queries,
      customModels: customModelsOf(new Map([["mine", new Set(["canonical-fast"])]]), new Map([["other", ["x"]]])),
    });

    const availability = await Effect.runPromise(service.availability("u1", true));

    expect(availability.accountCountByProvider.get("p")).toBe(2);
    expect(availability.accountTierById.get("a1")).toBe("pro");
    expect(availability.disabledCountByProviderModel.get("p:m")).toBe(1);
    expect(availability.disabledCountByProviderModel.get("p:canonical-fast")).toBe(1);
    expect(availability.accountCountByProvider.get("opencode")).toBe(2);
    expect(availability.authlessModels.get("opencode")).toEqual(new Set(["oc-model"]));
    expect(availability.customProviderModels.has("mine")).toBe(false);
    expect(availability.customProviderStandaloneModels.get("other")).toEqual(["x"]);
    expect(availability.sharedAccountCountByProvider.get("q")).toBe(1);
    expect(availability.sharedAccountTiersByProvider.get("q")).toEqual(["max"]);
    expect(availability.sharedDisabledCountByProviderModel.get("q:m")).toBe(1);
  });

  it("filters unusable and disabled models from candidates", async () => {
    const registry = registryOf({ providerModels: { p: ["m1", "m2"] } });
    const { redis } = redisOf();
    const { queries } = queriesOf({
      accounts: [{ id: "a1", provider: "p", tier: null }],
      disabledByUser: ["m2"],
    });
    const service = serviceOf({ registry, redis, queries });

    const whitelist = await Effect.runPromise(
      service.candidates("u1", "p", "whitelist", new Set(["m1"]), false)
    );
    expect(whitelist).toEqual(["m1"]);

    const blacklist = await Effect.runPromise(
      service.candidates("u1", "p", "blacklist", new Set(["m2"]), true)
    );
    expect(blacklist).toEqual(["m1"]);
  });
});
