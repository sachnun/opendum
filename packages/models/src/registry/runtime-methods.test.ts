import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Registry,
  flagshipFamilyRanking,
  legacyNvidiaAlias,
  normalizeProviderAlias,
  type ModelEntry,
} from "#models/registry/runtime.ts";

function baseEntries(): ModelEntry[] {
  return [
    {
      fileId: "alpha",
      owner: "anthropic",
      info: {
        id: "alpha",
        providers: ["openrouter", "kiro"],
        aliases: ["alpha-alias"],
        family: "claude",
        owner: "anthropic",
        reasoning: true,
        reasoning_effort: ["low", "high"],
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1000, output: 100 },
        cost: { input: 1 },
        providerConfig: {
          kiro: { upstream: "kiro-alpha", minTier: "pro", allowedTiers: ["pro"] },
          openrouter: { authless: true, free: true },
        },
      },
    },
    {
      fileId: "beta",
      owner: "meta",
      info: { id: "beta", providers: ["nvidia_nim"], providerConfig: { nvidia_nim: { upstream: "library/beta:v1" } } },
    },
    { fileId: "ghost", owner: "x", info: { id: "ghost", providers: ["openrouter"], ignored: true } },
    { fileId: "folder-model", owner: "anthropic", info: { providers: ["kiro"] } },
  ];
}

function registry(): Registry {
  return Registry.fromEntries(baseEntries());
}

describe("registry name helpers", () => {
  it("normalizes provider aliases", () => {
    assert.equal(normalizeProviderAlias("  Kiro "), "kiro");
  });

  it("derives legacy nvidia aliases", () => {
    assert.equal(legacyNvidiaAlias("library/meta/llama-3"), "meta-llama-3");
    assert.equal(legacyNvidiaAlias("plain"), "plain");
  });

  it("ranks flagship families", () => {
    const ranking = flagshipFamilyRanking([
      { fileId: "a", owner: "anthropic", info: { id: "a", providers: ["p"], family: "Claude", scores: { artificialAnalysis: { index: 10 } } } },
      { fileId: "b", owner: "anthropic", info: { id: "b", providers: ["p"], family: "Claude", scores: { artificialAnalysis: { index: 30 } } } },
      { fileId: "c", owner: "anthropic", info: { id: "c", providers: ["p"], scores: { artificialAnalysis: { index: 5 } } } },
      { fileId: "d", owner: "anthropic", info: { id: "d", providers: ["p"], scores: { artificialAnalysis: { index: Number.NaN } } } },
    ]);
    assert.equal(ranking[0]!.family, "Claude");
    assert.equal(ranking[0]!.score, 30);
  });
});

describe("Registry lookups", () => {
  it("resolves aliases and lookup keys", () => {
    const reg = registry();
    assert.equal(reg.resolveAlias("alpha-alias"), "alpha");
    assert.equal(reg.resolveAlias("ALPHA"), "alpha");
    assert.equal(reg.resolveAlias("  "), "");
    assert.deepEqual(reg.lookupKeys("alpha"), ["alpha", "alpha-alias", "kiro-alpha"]);
    assert.equal(reg.resolveAlias("library/beta:v1"), "beta");
    assert.equal(reg.resolveAlias("beta-v1"), "beta");
    assert.equal(reg.resolveAlias("unknown"), "unknown");
  });

  it("resolves providers and upstream names", () => {
    const reg = registry();
    assert.deepEqual(reg.providersForModel("alpha"), ["openrouter", "kiro"]);
    assert.equal(reg.isSupported("alpha"), true);
    assert.equal(reg.isSupported("missing"), false);
    assert.equal(reg.isSupportedByProvider("alpha", "kiro"), true);
    assert.equal(reg.upstreamModelName("alpha", "kiro"), "kiro-alpha");
    assert.equal(reg.upstreamModelName("alpha", "openrouter"), "alpha");
    assert.equal(reg.upstreamModelName("missing", "kiro"), "missing");
  });

  it("reads provider access rules and configs", () => {
    const reg = registry();
    assert.deepEqual(reg.providerAccessRule("alpha", "kiro"), { minTier: "pro", allowedTiers: ["pro"] });
    assert.equal(reg.providerAccessRule("alpha", "openrouter"), null);
    assert.equal(reg.providerAccessRule("missing", "kiro"), null);
    assert.equal(reg.providerModelConfig("missing", "kiro"), null);
    assert.equal(reg.isAuthlessProviderModel("alpha", "openrouter"), true);
    assert.equal(reg.isAuthlessProviderModel("alpha", "kiro"), false);
    assert.equal(reg.isFreeProviderModel("alpha", "openrouter"), true);
  });

  it("lists authless provider models", () => {
    const reg = registry();
    assert.deepEqual([...reg.authlessProviderModels()], [["openrouter", ["alpha"]]]);
  });

  it("caches provider model maps and sets", () => {
    const reg = registry();
    const map = reg.providerModelMap("kiro");
    assert.equal(map.get("alpha"), "kiro-alpha");
    assert.equal(reg.providerModelMap("kiro"), map);
    const set = reg.providerModelSet("kiro");
    assert.deepEqual([...set], ["alpha", "folder-model"]);
    assert.equal(reg.providerModelSet("kiro"), set);
  });

  it("lists models and families", () => {
    const reg = registry();
    assert.deepEqual(reg.allModels(), ["alpha", "beta", "folder-model"]);
    assert.deepEqual(reg.modelsForProvider("kiro"), ["alpha", "folder-model"]);
    assert.deepEqual(reg.ignoredModels(), ["ghost"]);
    assert.deepEqual(reg.families(), ["claude"]);
    assert.equal(reg.modelFamily("alpha"), "claude");
    assert.deepEqual(reg.modelCost("alpha"), { input: 1 });
    assert.equal(reg.modelInfo("missing"), null);
    assert.equal("ghost" in reg.entries(), false);
  });
});

describe("Registry suggestions", () => {
  it("suggests scoped and global matches", () => {
    const reg = registry();
    assert.deepEqual(reg.suggestedModels("alpha", "kiro", null, 5), ["kiro/alpha"]);
    assert.deepEqual(reg.suggestedModels("alpha", "unknown", null, 5), ["alpha"]);
    assert.deepEqual(reg.suggestedModels("alpha", null, ["alpha", "beta"], 5), ["alpha"]);
    assert.deepEqual(reg.suggestedModels("alpha", "kiro", ["alpha", "beta"], 5), ["kiro/alpha"]);
    assert.deepEqual(reg.suggestedModels("", "kiro", null, 5), []);
    assert.deepEqual(reg.suggestedModels("alpha", "kiro", null, 0), []);
  });
});

describe("Registry formatting", () => {
  it("formats models for the OpenAI API", () => {
    const reg = registry();
    const items = reg.formatModelsForOpenAI();
    const alpha = items.find((item) => item.id === "alpha")!;
    assert.equal(alpha.owner, "anthropic");
    assert.equal(alpha.reasoning, true);
    assert.deepEqual(alpha.reasoning_effort, ["low", "high"]);
    assert.deepEqual(alpha.modalities, { input: ["text", "image"], output: ["text"] });
    assert.deepEqual(alpha.limit, { context: 1000, output: 100 });

    const folderModel = items.find((item) => item.id === "folder-model")!;
    assert.equal(folderModel.reasoning, true);
    assert.equal("reasoning_effort" in folderModel, false);
    assert.equal("limit" in folderModel, false);
    assert.equal(items.some((item) => item.id === "ghost"), false);

    assert.equal(reg.isReasoningModel("alpha"), true);
    assert.equal(reg.isReasoningModel("missing"), false);
    assert.equal(reg.isVisionModel("alpha"), true);
    assert.equal(reg.isVisionModel("missing"), false);
  });
});

describe("Registry merging", () => {
  it("merges duplicate model ids", () => {
    const reg = Registry.fromEntries([
      {
        fileId: "dup",
        owner: "o",
        info: { id: "dup", providers: ["a"], aliases: ["d"], description: "orig", family: "f", reasoning: null, providerConfig: { a: { upstream: "u" } } },
      },
      {
        fileId: "dup2",
        owner: "o",
        info: { id: "dup", providers: ["b"], aliases: ["e"], description: "new", family: "g", reasoning: true },
      },
    ]);
    assert.deepEqual(reg.providersForModel("dup"), ["a", "b"]);
    assert.equal(reg.modelFamily("dup"), "f");
    assert.equal(reg.isReasoningModel("dup"), true);
    assert.equal(reg.resolveAlias("dup2"), "dup");
  });

  it("infers families from folders", () => {
    const reg = Registry.fromEntries([{ fileId: "fm", owner: "anthropic", info: { providers: ["kiro"] } }], { familyFromFolder: true });
    assert.equal(reg.modelFamily("fm"), "Anthropic");
  });
});
