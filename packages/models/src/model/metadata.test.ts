import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MODELSDEV_CANONICAL_URL } from "#models/model/canonical.ts";
import {
  LITELLM_URL,
  MODELSDEV_URL,
  NVIDIA_MODELS_URL,
  OPENROUTER_MODELS_URL,
  buildModelPatch,
  fetchExternalRegistries,
  resolveModelMetadata,
  type Registries,
  type ResolvedHit,
  type ResolvedMetadata,
} from "#models/model/metadata.ts";
import { buildIndex } from "#models/model/similarity.ts";

type Json = Record<string, unknown>;

const openrouterEntry: Json = {
  context_length: 1000,
  top_provider: { context_length: 2000, max_completion_tokens: 500 },
  pricing: { prompt: "0.000001", completion: 0.000002, input_cache_read: 0.0000005, input_cache_write: 0 },
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  reasoning: { supported_efforts: ["low", "HIGH", "bogus"] },
};

const modelsdevEntry: Json = {
  limit: { context: 4000, output: 800 },
  cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 0.25 },
  modalities: { input: ["text"], output: ["text", "image"] },
  reasoning: true,
  reasoning_options: [{ type: "effort", values: ["medium", "max"] }],
};

const litellmEntry: Json = {
  max_input_tokens: 9000,
  max_output_tokens: 1000,
  input_cost_per_token: 0.000001,
  output_cost_per_token: 0.000002,
  cache_read_input_token_cost: 0.0000005,
  cache_creation_input_token_cost: 0.0000001,
  supports_reasoning: true,
};

function hit(source: ResolvedHit["source"], entry: unknown, provider?: string): ResolvedHit {
  return { source, id: "m", entry, provider };
}

function patchFor(resolved: ResolvedMetadata, providers: string[]): ReturnType<typeof buildModelPatch> {
  return buildModelPatch({ id: "m", candidates: ["m"], providers }, resolved);
}

describe("buildModelPatch", () => {
  it("combines per-provider and global metadata", () => {
    const patch = patchFor(
      {
        perProvider: { openrouter: hit("openrouter", openrouterEntry, "openrouter") },
        global: { modelsdev: hit("modelsdev", modelsdevEntry), litellm: hit("litellm", litellmEntry) },
      },
      ["openrouter", "kilo_code"]
    );

    assert.deepEqual(patch.providerLimits.openrouter, { contextWindow: 1000, maxOutputTokens: 500 });
    assert.deepEqual(patch.providerLimits.kilo_code, { contextWindow: 4000, maxOutputTokens: 800 });
    assert.deepEqual(patch.limits, { context: 4000, output: 800 });
    assert.equal(patch.resolvedProviders, 1);
    assert.deepEqual(patch.modalities, { input: ["image", "text"], output: ["text"] });
    assert.equal(patch.reasoning, true);
    assert.deepEqual(patch.reasoningEffort, ["low", "high"]);
    assert.deepEqual(patch.cost, { input: 5, output: 10, cacheRead: 2.5, cacheWrite: 0.5 });
    assert.equal(patch.minimumProviderContext, 1000);
    assert.equal(patch.maximumProviderContext, 4000);
  });

  it("handles reasoning flags across sources", () => {
    assert.equal(patchFor({ perProvider: {}, global: { openrouter: hit("openrouter", { reasoning: false }) } }, ["openrouter"]).reasoning, false);
    assert.equal(patchFor({ perProvider: {}, global: { litellm: hit("litellm", { supports_reasoning: false }) } }, ["litellm"]).reasoning, false);
    assert.equal(
      patchFor({ perProvider: {}, global: { openrouter: hit("openrouter", { supported_parameters: ["reasoning"] }) } }, ["openrouter"]).reasoning,
      true
    );
    assert.equal(patchFor({ perProvider: {}, global: { modelsdev: hit("modelsdev", { reasoning: "yes" }) } }, ["modelsdev"]).reasoning, null);
    assert.equal(patchFor({ perProvider: {}, global: { modelsdev: hit("modelsdev", { reasoning: true }) } }, ["modelsdev"]).reasoning, true);
    assert.equal(patchFor({ perProvider: {}, global: { litellm: hit("litellm", { supports_reasoning: true }) } }, ["litellm"]).reasoning, true);
  });

  it("merges zero and free costs", () => {
    const zero = patchFor({ perProvider: {}, global: { openrouter: hit("openrouter", { pricing: { prompt: 0 } }) } }, ["openrouter"]);
    assert.deepEqual(zero.cost, { input: 0 });
    assert.equal(patchFor({ perProvider: {}, global: {} }, []).cost, null);
  });

  it("handles modality defaults and unsupported sources", () => {
    const defaulted = patchFor(
      { perProvider: {}, global: { openrouter: hit("openrouter", { architecture: { input_modalities: ["text"], output_modalities: [] } }) } },
      ["openrouter"]
    );
    assert.deepEqual(defaulted.modalities, { input: ["text"], output: ["text"] });

    const unsupported = patchFor(
      { perProvider: {}, global: { openrouter: hit("openrouter", { architecture: { input_modalities: ["bogus"] } }) } },
      ["openrouter"]
    );
    assert.equal(unsupported.modalities, null);

    const nvidia = patchFor({ perProvider: {}, global: { nvidia: hit("nvidia", { limit: { context: 1 } }) } }, ["nvidia_nim"]);
    assert.deepEqual(nvidia.providerLimits, {});
    assert.deepEqual(nvidia.limits, {});
    assert.equal(nvidia.minimumProviderContext, null);
  });

  it("skips provider limits without values", () => {
    const patch = patchFor({ perProvider: { kiro: hit("modelsdev", {}) }, global: {} }, ["kiro"]);
    assert.deepEqual(patch.providerLimits, {});
    assert.equal(patch.resolvedProviders, 1);
  });
});

describe("resolveModelMetadata", () => {
  it("resolves provider-scoped and global hits", () => {
    const modelsdevIndex = buildIndex([{ id: "gpt-4o", name: "GPT-4o", provider: "openai", entry: modelsdevEntry }], "modelsdev");
    const openrouterIndex = buildIndex([{ id: "openai/gpt-4o", provider: "openrouter", entry: openrouterEntry }], "openrouter");
    const nvidiaIndex = buildIndex([{ id: "nvidia/llama", provider: "nvidia", entry: {} }], "nvidia");
    const registries = {
      modelsdev: { entries: [], index: modelsdevIndex, byProvider: { openai: modelsdevIndex } },
      openrouter: { entries: [], index: openrouterIndex, byProvider: {} },
      nvidia: { entries: [], index: nvidiaIndex, byProvider: {} },
    } as unknown as Registries;

    const resolved = resolveModelMetadata(
      { id: "gpt-4o", candidates: ["gpt-4o", "llama"], providers: ["codex", "openrouter", "nvidia_nim", "unknown"] },
      registries
    );

    assert.equal(resolved.perProvider.codex!.source, "modelsdev");
    assert.equal(resolved.perProvider.codex!.provider, "openai");
    assert.equal(resolved.perProvider.openrouter!.source, "openrouter");
    assert.equal(resolved.perProvider.nvidia_nim!.source, "nvidia");
    assert.equal(resolved.global.modelsdev!.id, "gpt-4o");
    assert.equal(resolved.global.openrouter!.id, "openai/gpt-4o");
    assert.equal(resolved.global.litellm, undefined);
  });
});

describe("fetchExternalRegistries", () => {
  it("builds registries and canonical models from fetches", async () => {
    const originalFetch = globalThis.fetch;
    const payloads: Record<string, unknown> = {
      [OPENROUTER_MODELS_URL]: { data: [{ id: "m1", name: "M1" }, { name: "no-id" }] },
      [MODELSDEV_URL]: { openai: { models: { gpt: { name: "GPT" } } } },
      [LITELLM_URL]: { "gpt-4": { name: "G", litellm_provider: "openai" } },
      [NVIDIA_MODELS_URL]: { data: [{ id: "n1", owned_by: "nvidia" }] },
      [MODELSDEV_CANONICAL_URL]: { m1: { name: "M1" } },
    };
    globalThis.fetch = (async (url: string) =>
      new Response(JSON.stringify(payloads[url] ?? {}), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    const logs: string[] = [];
    try {
      const catalogs = await fetchExternalRegistries({ logger: (message) => logs.push(message) });
      assert.equal(catalogs.registries.openrouter!.entries.length, 1);
      assert.equal(catalogs.registries.modelsdev!.entries.length, 1);
      assert.equal(catalogs.registries.litellm!.entries.length, 1);
      assert.equal((catalogs.registries.nvidia!.entries[0] as { name?: string }).name, "n1");
      assert.equal(catalogs.registries.modelsdev!.byProvider.openai!.size, 1);
      assert.ok(catalogs.canonical);
      assert.ok(logs.some((line) => line.includes("canonical models")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
