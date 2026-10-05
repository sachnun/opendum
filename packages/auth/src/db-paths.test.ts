import assert from "node:assert/strict";
import { beforeEach, describe, mock, test } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/redis";

type Json = Record<string, unknown>;

const state = {
  apiKey: null as Json | null,
  rateLimits: [] as Json[],
  disabledModels: [] as string[],
  activeAccounts: [] as Json[],
  sharedAccounts: [] as Json[],
  disabledByAccount: new Map<string, string[]>(),
  customProviders: [] as Json[],
  customProvider: null as Json | null,
  customModels: [] as Json[],
};

const calls = { deactivate: 0, touch: 0 };

mock.module("@opendum/database/queries", {
  namedExports: {
    getAPIKeyByHash: async () => state.apiKey,
    deactivateAPIKey: async () => {
      calls.deactivate += 1;
    },
    listDisabledModelsByUser: async () => state.disabledModels,
    listAPIKeyRateLimits: async () => state.rateLimits,
    touchAPIKeyLastUsed: async () => {
      calls.touch += 1;
    },
    listActiveAccountTiers: async () => state.activeAccounts,
    listDisabledModelsByAccounts: async (accountIds: string[]) =>
      accountIds.flatMap((id) => (state.disabledByAccount.get(id) ?? []).map((model) => ({ providerAccountId: id, model }))),
    listSharedAccounts: async () => state.sharedAccounts,
    listCustomProviders: async () => state.customProviders,
    getCustomProvider: async () => state.customProvider,
    listCustomProviderModels: async () => state.customModels,
  },
});

const { AuthService } = await import("#auth/service.ts");
const { createCustomStore } = await import("#auth/custom-store.ts");
const { computeAccountModelAvailability } = await import("#auth/availability.ts");

function fakeRedis(store = new Map<string, string>()): OpendumRedis {
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
    del: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) store.delete(key);
      return list.length;
    },
  } as unknown as OpendumRedis;
}

function fakeRegistry(overrides: Partial<Registry> = {}): Registry {
  return {
    resolveAlias: (model: string) => model,
    isSupported: () => true,
    isSupportedByProvider: () => true,
    providersForModel: () => ["kiro"],
    providerModelMap: () => new Map(),
    allModels: () => [],
    modelsForProvider: () => [],
    suggestedModels: () => [],
    modelInfo: () => null,
    authlessProviderModels: () => new Map(),
    providerAccessRule: () => null,
    ...overrides,
  } as unknown as Registry;
}

const customProviders = {
  listProviders: async () => [],
  getProvider: async () => null,
  listModels: async () => [],
};

beforeEach(() => {
  state.apiKey = null;
  state.rateLimits = [];
  state.disabledModels = [];
  state.activeAccounts = [];
  state.sharedAccounts = [];
  state.disabledByAccount = new Map();
  state.customProviders = [];
  state.customProvider = null;
  state.customModels = [];
  calls.deactivate = 0;
  calls.touch = 0;
});

describe("AuthService database paths", () => {
  test("rejects unknown API keys and caches the failure", async () => {
    const store = new Map<string, string>();
    const service = new AuthService(fakeRegistry(), fakeRedis(store), customProviders);
    const result = await service.validateAPIKey("Bearer missing");
    assert.equal(result.valid, false);
    assert.equal(result.error, "Invalid API key");
    assert.equal(store.size, 1);
  });

  test("rejects revoked and expired keys", async () => {
    state.apiKey = { id: "k1", userId: "u1", isActive: false, expiresAt: null };
    const revoked = await new AuthService(fakeRegistry(), fakeRedis(), customProviders).validateAPIKey("Bearer k");
    assert.equal(revoked.error, "API key has been revoked");

    state.apiKey = { id: "k1", userId: "u1", isActive: true, expiresAt: new Date(Date.now() - 1000) };
    const expired = await new AuthService(fakeRegistry(), fakeRedis(), customProviders).validateAPIKey("Bearer k");
    assert.equal(expired.error, "API key has expired");
    assert.equal(calls.deactivate, 1);
  });

  test("accepts valid keys and loads rate limits", async () => {
    state.apiKey = {
      id: "k1",
      userId: "u1",
      isActive: true,
      expiresAt: null,
      modelAccessMode: "whitelist",
      modelAccessList: ["m1"],
      accountAccessMode: "all",
      accountAccessList: [],
      roamingEnabled: true,
    };
    state.rateLimits = [{ target: "m1", targetType: "model", perMinute: 5, perHour: null, perDay: null }];
    const service = new AuthService(fakeRegistry(), fakeRedis(), customProviders);
    const result = await service.validateAPIKey("Bearer k");
    assert.equal(result.valid, true);
    assert.equal(result.userId, "u1");
    assert.equal(result.modelAccessMode, "whitelist");
    assert.deepEqual(result.modelAccessList, ["m1"]);
    assert.equal(result.rateLimitRules.length, 1);
    assert.equal(calls.touch, 1);
  });

  test("loads disabled models from the database", async () => {
    state.disabledModels = ["m1", " m2 "];
    const service = new AuthService(fakeRegistry(), fakeRedis(), customProviders);
    const set = await service.disabledModelSetForUser("u1");
    assert.equal(set.has("m1"), true);
    assert.equal(set.has("m2"), true);
  });

  test("wraps custom store database queries", async () => {
    state.customProviders = [{ id: "cp1" }];
    state.customProvider = { id: "cp1" };
    state.customModels = [{ id: "m1" }];
    const store = createCustomStore();
    assert.deepEqual(await store.listProviders("u1"), [{ id: "cp1" }]);
    assert.deepEqual(await store.getProvider("u1", "slug"), { id: "cp1" });
    assert.deepEqual(await store.listModels("cp1"), [{ id: "m1" }]);
  });
});

describe("computeAccountModelAvailability", () => {
  test("aggregates accounts, disabled models and sharing", async () => {
    state.activeAccounts = [
      { id: "a1", provider: "kiro", tier: " Pro " },
      { id: "a2", provider: "kiro", tier: "" },
    ];
    state.sharedAccounts = [{ id: "s1", provider: "kiro", tier: "free" }];
    state.disabledByAccount = new Map([
      ["a1", ["m1"]],
      ["s1", ["m2"]],
    ]);
    const registry = fakeRegistry({
      authlessProviderModels: () => new Map([["opencode", ["m1"]]]),
    });
    const availability = await computeAccountModelAvailability(
      registry,
      async () => ({ aliased: new Map([["kiro", new Set(["m1"])]]), standalone: new Map([["custom", ["x"]]]) }),
      "u1",
      true
    );
    assert.equal(availability.accountCountByProvider.get("kiro"), 2);
    assert.equal(availability.accountTierById.get("a1"), "pro");
    assert.equal(availability.accountTierById.has("a2"), false);
    assert.equal(availability.disabledCountByProviderModel.get("kiro:m1"), 1);
    assert.equal(availability.customProviderModels.get("kiro")?.has("m1"), true);
    assert.deepEqual(availability.customProviderStandaloneModels.get("custom"), ["x"]);
    assert.equal(availability.sharedAccountCountByProvider.get("kiro"), 1);
    assert.equal(availability.sharedDisabledCountByProviderModel.get("kiro:m2"), 1);
    assert.deepEqual(availability.sharedAccountTiersByProvider.get("kiro"), ["free"]);
    assert.equal(availability.authlessProviderModels.get("opencode")?.has("m1"), true);
  });

  test("skips shared data when disabled", async () => {
    state.activeAccounts = [{ id: "a1", provider: "kiro", tier: null }];
    const availability = await computeAccountModelAvailability(fakeRegistry(), async () => ({ aliased: new Map(), standalone: new Map() }), "u1", false);
    assert.equal(availability.accountCountByProvider.get("kiro"), 1);
    assert.equal(availability.sharedAccountCountByProvider.size, 0);
  });
});

describe("AuthService custom and analytics paths", () => {
  const customProvider = { id: "cp1", slug: "custom", userId: "u1" };
  const reader = {
    listProviders: async () => [customProvider],
    getProvider: async () => customProvider,
    listModels: async () => [{ modelId: "m1", aliased: false, upstream: null }],
  };

  test("lists custom models", async () => {
    const service = new AuthService(fakeRegistry(), fakeRedis(), reader as never);
    const items = await service.listUserCustomModels("u1");
    assert.deepEqual(items, [{ id: "custom/m1", object: "model", created: items[0]!.created, owned_by: "custom:custom" }]);
  });

  test("bumps analytics cache versions", async () => {
    const store = new Map<string, string>();
    const redis = {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string) => {
        store.set(key, value);
        return "OK";
      },
      incr: async (key: string) => {
        const next = Number(store.get(key) ?? 0) + 1;
        store.set(key, String(next));
        return next;
      },
      expire: async () => 1,
    } as unknown as OpendumRedis;
    const service = new AuthService(fakeRegistry(), redis, customProviders);
    await service.bumpAnalyticsCacheVersionThrottled("u1");
    assert.ok([...store.keys()].some((key) => key.includes("analytics")));
  });

  test("validates codex models", () => {
    const registry = fakeRegistry({ providerModelMap: () => new Map([["gpt-5", "gpt-5-codex"]]) });
    const service = new AuthService(registry, fakeRedis(), customProviders);
    assert.equal(service.validateModel("codex/gpt-5").valid, true);
    assert.equal(service.validateModel("codex/other").code, "unsupported_codex_chatgpt_model");
  });
});
