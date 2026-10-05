import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashString } from "@opendum/crypto";
import type { Registry } from "@opendum/models/runtime";
import { apiKeyLastUsedKey, apiKeyValidationKey, disabledModelsKey, type OpendumRedis } from "@opendum/redis";
import type {
  CustomProviderModelRecord,
  CustomProviderReader,
  CustomProviderRecord,
} from "#auth/custom-store.ts";
import { AuthService } from "#auth/service.ts";

type Store = Map<string, string>;

function fakeRedis(store: Store = new Map(), options: { setResult?: boolean } = {}): OpendumRedis {
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return options.setResult ?? true;
    },
    del: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) store.delete(key);
      return list.length;
    },
    incr: async (key: string) => {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(next));
      return next;
    },
    expire: async () => 1,
  } as unknown as OpendumRedis;
}

type RegistryOptions = {
  supported?: string[];
  aliases?: Record<string, string>;
  providersByModel?: Record<string, string[]>;
  providerModels?: Record<string, Set<string>>;
  providerModelMaps?: Record<string, Array<[string, string]>>;
  modelInfos?: Record<string, { modalities?: { input?: string[] } | null }>;
};

function fakeRegistry(options: RegistryOptions = {}): Registry {
  const supported = new Set(options.supported ?? ["claude-x", "gpt-chatgpt"]);
  const aliases = options.aliases ?? {};
  const providerModels = options.providerModels ?? { kiro: new Set(["claude-x"]), codex: new Set(["gpt-chatgpt"]) };
  return {
    resolveAlias: (model: string) => aliases[model] ?? model,
    isSupported: (model: string) => supported.has(model),
    isSupportedByProvider: (model: string, provider: string) => (providerModels[provider] ?? new Set()).has(model),
    providersForModel: (model: string) => options.providersByModel?.[model] ?? [],
    providerModelMap: (provider: string) => new Map(options.providerModelMaps?.[provider] ?? []),
    allModels: () => [...supported].sort(),
    modelsForProvider: (provider: string) => [...(providerModels[provider] ?? new Set())].sort(),
    suggestedModels: (model: string, _provider: string | null, candidates: string[] | null, limit: number) =>
      (candidates ?? []).slice(0, limit),
    modelInfo: (model: string) => options.modelInfos?.[model] ?? null,
  } as unknown as Registry;
}

function customReader(models: Record<string, CustomProviderModelRecord[]> = {}): CustomProviderReader {
  const provider: CustomProviderRecord = {
    id: "cp1",
    userId: "u",
    slug: "myprov",
    name: "My Provider",
    baseUrl: "",
    extraHeaders: null,
    enabled: true,
  };
  return {
    listProviders: async (userId: string) => (userId === "u" ? [provider] : []),
    getProvider: async (userId: string, slug: string) => (userId === "u" && slug === "myprov" ? provider : null),
    listModels: async (providerId: string) => models[providerId] ?? [],
  };
}

function modelRow(overrides: Partial<CustomProviderModelRecord> = {}): CustomProviderModelRecord {
  return {
    id: "m1",
    providerId: "cp1",
    modelId: "claude-x",
    upstream: null,
    aliased: false,
    authless: false,
    minTier: null,
    allowedTiers: null,
    customFlags: null,
    ...overrides,
  };
}

describe("AuthService.validateAPIKey", () => {
  it("rejects missing headers", async () => {
    const service = new AuthService(fakeRegistry(), fakeRedis());
    const result = await service.validateAPIKey("   ");
    assert.equal(result.valid, false);
    assert.match(result.error, /Missing Authorization header/);
  });

  it("returns cached invalid results", async () => {
    const token = "tok";
    const store: Store = new Map();
    store.set(apiKeyValidationKey(hashString(token)), JSON.stringify({ valid: false, error: "nope" }));
    const service = new AuthService(fakeRegistry(), fakeRedis(store));
    const result = await service.validateAPIKey(`Bearer ${token}`);
    assert.equal(result.error, "nope");

    const fallbackStore: Store = new Map();
    fallbackStore.set(apiKeyValidationKey(hashString(token)), JSON.stringify({ valid: false }));
    const fallback = await new AuthService(fakeRegistry(), fakeRedis(fallbackStore)).validateAPIKey(`Bearer ${token}`);
    assert.equal(fallback.error, "Invalid API key");
  });

  it("returns cached valid results", async () => {
    const token = "tok2";
    const cached = {
      valid: true,
      userId: "u1",
      apiKeyId: "",
      modelAccessMode: "whitelist",
      modelAccessList: ["claude-x"],
      roamingEnabled: true,
      expiresAtMs: Date.now() + 60_000,
      rateLimitRules: [],
    };
    const store: Store = new Map();
    store.set(apiKeyValidationKey(hashString(token)), JSON.stringify(cached));
    const result = await new AuthService(fakeRegistry(), fakeRedis(store)).validateAPIKey(`Bearer ${token}`);
    assert.equal(result.valid, true);
    assert.equal(result.userId, "u1");
    assert.equal(result.modelAccessMode, "whitelist");
    assert.deepEqual(result.modelAccessList, ["claude-x"]);
    assert.equal(result.roamingEnabled, true);
  });

  it("touches last-used only when redis claims the lock", async () => {
    const token = "tok3";
    const cached = { valid: true, userId: "u1", apiKeyId: "k1", expiresAtMs: Date.now() + 60_000 };
    const store: Store = new Map();
    store.set(apiKeyValidationKey(hashString(token)), JSON.stringify(cached));
    const result = await new AuthService(fakeRegistry(), fakeRedis(store, { setResult: false })).validateAPIKey(`Bearer ${token}`);
    assert.equal(result.valid, true);

    const heldStore: Store = new Map();
    heldStore.set(apiKeyValidationKey(hashString(token)), JSON.stringify(cached));
    const invalidStore: Store = new Map();
    invalidStore.set(apiKeyValidationKey(hashString(token)), "not json");
    const recovered = await new AuthService(fakeRegistry(), fakeRedis(heldStore)).validateAPIKey(`Bearer ${token}`);
    assert.equal(recovered.valid, true);
  });
});

describe("AuthService.validateModel", () => {
  it("validates supported models", () => {
    const service = new AuthService(
      fakeRegistry({ providerModelMaps: { codex: [["gpt-chatgpt", "gpt-chatgpt-preview"]] } }),
      fakeRedis()
    );
    assert.equal(service.validateModel("claude-x").valid, true);
    assert.equal(service.validateModel("kiro/claude-x").valid, true);
    assert.equal(service.validateModel("codex/gpt-chatgpt").valid, true);
  });

  it("rejects unsupported providers, models and codex accounts", () => {
    const service = new AuthService(fakeRegistry(), fakeRedis());
    const wrongProvider = service.validateModel("openrouter/claude-x");
    assert.equal(wrongProvider.code, "invalid_provider_model");

    const unknown = service.validateModel("unknown-model");
    assert.equal(unknown.code, "invalid_model");

    const codex = service.validateModel("codex/claude-x");
    assert.equal(codex.code, "unsupported_codex_chatgpt_model");
    assert.match(codex.error, /not supported for Codex/);
  });
});

describe("AuthService.validateModelForUser", () => {
  it("validates custom provider models", async () => {
    const service = new AuthService(
      fakeRegistry({ modelInfos: { "claude-x": { modalities: { input: ["image"] } } } }),
      fakeRedis(new Map([[disabledModelsKey("u"), JSON.stringify({ models: [] })]])) ,
      customReader({ cp1: [modelRow()] })
    );
    const result = await service.validateModelForUser("u", "myprov/claude-x", { mode: "all", models: [], roamingEnabled: false });
    assert.equal(result.valid, true);
    assert.equal(result.provider, "myprov");
    assert.equal(result.model, "myprov/claude-x");
    assert.equal(result.vision, true);
  });

  it("resolves aliased custom models", async () => {
    const service = new AuthService(
      fakeRegistry({ aliases: { "alias-x": "claude-x" } }),
      fakeRedis(new Map([[disabledModelsKey("u"), JSON.stringify({ models: [] })]])),
      customReader({ cp1: [modelRow({ modelId: "alias-x", aliased: true })] })
    );
    const result = await service.validateModelForUser("u", "myprov/alias-x", { mode: "all", models: [], roamingEnabled: false });
    assert.equal(result.valid, true);
    assert.equal(result.alias, "claude-x");
  });

  it("rejects unknown custom models", async () => {
    const service = new AuthService(fakeRegistry(), fakeRedis(), customReader({ cp1: [modelRow()] }));
    const result = await service.validateModelForUser("u", "myprov/other", { mode: "all", models: [], roamingEnabled: false });
    assert.equal(result.valid, false);
    assert.equal(result.code, "invalid_model");
  });

  it("applies whitelist and blacklist modes for base models", async () => {
    const store: Store = new Map([[disabledModelsKey("u"), JSON.stringify({ models: [] })]]);
    const service = new AuthService(fakeRegistry(), fakeRedis(store), customReader());

    const whitelisted = await service.validateModelForUser("u", "claude-x", { mode: "whitelist", models: ["claude-x"], roamingEnabled: false });
    assert.equal(whitelisted.valid, true);

    const blacklisted = await service.validateModelForUser("u", "claude-x", { mode: "blacklist", models: [], roamingEnabled: false });
    assert.equal(blacklisted.valid, true);
  });

  it("reports disabled models", async () => {
    const store: Store = new Map([[disabledModelsKey("u"), JSON.stringify({ models: ["claude-x"] })]]);
    const service = new AuthService(fakeRegistry(), fakeRedis(store), customReader());
    const result = await service.validateModelForUser("u", "claude-x", { mode: "all", models: [], roamingEnabled: false });
    assert.equal(result.valid, false);
    assert.equal(result.code, "model_disabled");
  });
});

describe("AuthService custom model listing and disabled models", () => {
  it("lists user custom models", async () => {
    const service = new AuthService(
      fakeRegistry({ aliases: { "alias-x": "claude-x" } }),
      fakeRedis(),
      customReader({ cp1: [modelRow(), modelRow({ id: "m2", modelId: "alias-x", aliased: true })] })
    );
    const items = await service.listUserCustomModels("u");
    assert.deepEqual(items, [
      { id: "myprov/claude-x", object: "model", created: items[0]!.created, owned_by: "custom:myprov" },
    ]);
  });

  it("reads the disabled model set", async () => {
    const store: Store = new Map([[disabledModelsKey("u"), JSON.stringify({ models: ["claude-x"] })]]);
    const service = new AuthService(fakeRegistry(), fakeRedis(store), customReader());
    assert.equal(await service.isModelDisabledForUser("u", "claude-x"), true);
    assert.equal(await service.isModelDisabledForUser("u", "gpt-chatgpt"), false);
  });

  it("invalidates validation caches", async () => {
    const store: Store = new Map([
      [apiKeyValidationKey("a"), "1"],
      [apiKeyLastUsedKey("b"), "2"],
    ]);
    const service = new AuthService(fakeRegistry(), fakeRedis(store));
    await service.invalidateAPIKeyValidation("a", "b");
    assert.equal(store.has(apiKeyValidationKey("a")), false);
    assert.equal(store.has(apiKeyLastUsedKey("b")), false);

    const onlyValidation: Store = new Map([[apiKeyValidationKey("c"), "1"]]);
    await new AuthService(fakeRegistry(), fakeRedis(onlyValidation)).invalidateAPIKeyValidation("c", "");
    assert.equal(onlyValidation.size, 0);
  });

  it("bumps analytics versions when the throttle lock is free", async () => {
    const store: Store = new Map();
    const service = new AuthService(fakeRegistry(), fakeRedis(store));
    await service.bumpAnalyticsCacheVersionThrottled("u");
    assert.ok([...store.keys()].some((key) => key.includes("analytics")));
    await service.bumpAnalyticsCacheVersionThrottled("");
  });
});
