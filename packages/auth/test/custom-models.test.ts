import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { CustomModels } from "../custom-models.js";
import type { ModelRecord, CustomProviderReader } from "../store/custom.js";

function modelRecord(overrides: Partial<ModelRecord> & { modelId: string }): ModelRecord {
  return {
    id: `m-${overrides.modelId}`,
    providerId: overrides.providerId ?? "p1",
    modelId: overrides.modelId,
    upstream: overrides.upstream ?? null,
    aliased: overrides.aliased ?? false,
    authless: false,
    minTier: null,
    allowedTiers: null,
    customFlags: null,
  };
}

function providerOf(id: string, slug: string) {
  return { id, userId: "u1", slug, name: slug, baseUrl: "https://example.test", extraHeaders: null, enabled: true };
}

function readerOf(
  providers: Array<{ id: string; slug: string; models: ModelRecord[] }>
): CustomProviderReader {
  return {
    listProviders: () =>
      Effect.succeed(providers.map((provider) => providerOf(provider.id, provider.slug))),
    getProvider: (_userId: string, slug: string) => {
      const provider = providers.find((candidate) => candidate.slug === slug);
      return Effect.succeed(provider ? providerOf(provider.id, provider.slug) : null);
    },
    listModels: (providerId: string) =>
      Effect.succeed(providers.find((candidate) => candidate.id === providerId)?.models ?? []),
  } as unknown as CustomProviderReader;
}

function serviceOf(
  reader: CustomProviderReader,
  options: { aliases?: Record<string, string>; supported?: string[]; vision?: Record<string, boolean> } = {}
): CustomModels {
  const aliases = options.aliases ?? {};
  const supported = new Set(options.supported ?? []);
  const vision = options.vision ?? {};
  const registry = {
    resolveAlias: (model: string) => aliases[model] ?? model,
    isSupported: (model: string) => supported.has(model),
    modelInfo: (model: string) =>
      vision[model] === undefined ? null : { modalities: { input: vision[model] ? ["image"] : ["text"] } },
  } as unknown as Registry;
  return new CustomModels(registry, reader);
}

describe("CustomModels", () => {
  it("resolves a listed custom model with alias and vision", async () => {
    const service = serviceOf(
      readerOf([{ id: "p1", slug: "mine", models: [modelRecord({ modelId: "fast", upstream: "vendor/fast", aliased: true })] }]),
      { aliases: { fast: "canonical-fast" }, supported: ["canonical-fast"], vision: { "vendor/fast": true } }
    );

    const result = await Effect.runPromise(service.result("u1", "mine", "fast"));

    expect(result).toMatchObject({
      valid: true,
      provider: "mine",
      model: "mine/fast",
      alias: "canonical-fast",
      vision: true,
    });
  });

  it("returns null for unknown providers", async () => {
    const service = serviceOf(readerOf([]));

    const result = await Effect.runPromise(service.result("u1", "missing", "fast"));

    expect(result).toBeNull();
  });

  it("rejects models that are not registered under the provider", async () => {
    const service = serviceOf(
      readerOf([{ id: "p1", slug: "mine", models: [modelRecord({ modelId: "other" })] }])
    );

    const result = await Effect.runPromise(service.result("u1", "mine", "fast"));

    expect(result).toMatchObject({ valid: false, code: "invalid_model" });
    expect(result?.error).toContain('not registered under your custom provider "mine"');
  });

  it("splits aliased and standalone models", async () => {
    const service = serviceOf(
      readerOf([
        {
          id: "p1",
          slug: "mine",
          models: [
            modelRecord({ modelId: "fast", aliased: true }),
            modelRecord({ modelId: "weird", aliased: true }),
            modelRecord({ modelId: "extra" }),
          ],
        },
      ]),
      { aliases: { fast: "canonical-fast" }, supported: ["canonical-fast"] }
    );

    const sets = await Effect.runPromise(service.modelSets("u1"));

    expect(sets.aliased.get("mine")).toEqual(new Set(["canonical-fast"]));
    expect(sets.standalone.get("mine")).toEqual(["weird", "extra"]);
  });

  it("lists standalone custom models in the OpenAI shape", async () => {
    const service = serviceOf(
      readerOf([{ id: "p1", slug: "mine", models: [modelRecord({ modelId: "extra" })] }])
    );

    const items = await Effect.runPromise(service.list("u1"));

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "mine/extra", object: "model", owned_by: "custom:mine" });
  });
});
