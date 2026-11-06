import { Effect, Option, Schema } from "effect";
import { raise } from "@opendum/models/refresh/core/raise";
import { idMap } from "@opendum/models/model-store";
import { fetchDecoded } from "@opendum/models/sync/http";
import { entryFor, standardKey, writeEntry } from "@opendum/models/refresh/core/keys";
import { sourceOf, type ModelSource, type SourceResult } from "@opendum/models/refresh/core/types";
import { compareText } from "@opendum/models/compare";

const MODELS_URL = "https://zro.moonmath.ai/api/cli/models/public";
const FREE_PLAN_IDS = new Set(["deepseek-v4.1-flash", "glm-5.3-flash"]);

const Model = Schema.Struct({
  id: Schema.String,
  contextWindow: Schema.optional(Schema.Number),
  maxOutputTokens: Schema.optional(Schema.Number),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Schema.Array(Schema.String)),
      output: Schema.optional(Schema.Array(Schema.String)),
    })
  ),
  reasoning: Schema.optional(
    Schema.Struct({ levels: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))) })
  ),
});

const Catalog = Schema.Struct({ models: Schema.Array(Schema.Unknown) });

const decodeCatalog = Schema.decodeUnknownOption(Catalog);
const decodeModel = Schema.decodeUnknownOption(Model);

type Model = typeof Model.Type;

type Capabilities = {
  reasoning: boolean;
  modalities: { input: string[]; output: string[] } | null;
};

const textOutput = (model: Model): boolean => {
  const modalities = model.modalities?.output ?? [];
  return modalities.length === 0 || modalities.includes("text");
};

const catalogModels = (payload: unknown): ReadonlyArray<Model> => {
  const models = Option.match(decodeCatalog(payload), {
    onNone: () => [] as ReadonlyArray<unknown>,
    onSome: (value) => value.models,
  });
  if (models.length === 0) raise(new Error("unexpected Zro model catalog payload"));

  return models
    .flatMap((entry) => Option.match(decodeModel(entry), { onNone: () => [], onSome: (model) => [model] }))
    .filter(textOutput)
    .sort((left, right) => compareText(left.id, right.id));
};

const configFor = (model: Model): Record<string, unknown> => {
  const config: Record<string, unknown> = {};
  if (model.contextWindow && model.contextWindow > 0) config.contextWindow = model.contextWindow;
  if (model.maxOutputTokens && model.maxOutputTokens > 0) config.maxOutputTokens = model.maxOutputTokens;
  if (FREE_PLAN_IDS.has(model.id)) config.free = true;
  return config;
};

const capabilitiesFor = (model: Model): Capabilities => {
  const input = model.modalities?.input ?? [];
  const output = model.modalities?.output ?? [];
  return {
    reasoning: (model.reasoning?.levels ?? []).length > 0,
    modalities: input.length > 0 && output.length > 0 ? { input: [...input].sort(), output: [...output].sort() } : null,
  };
};

export const zroSource: ModelSource = {
  provider: "zro",
  label: "Zro",
  order: 75,
  phase: "fetch",

  fetch: () =>
    fetchDecoded(
      MODELS_URL,
      { label: "Zro model catalog", headers: { Accept: "application/json" } },
      async (response) => catalogModels(await response.json())
    ).pipe(
      Effect.map((catalog): SourceResult => {
        const models = idMap(
          catalog.map((model) => model.id),
          standardKey
        );
        const byUpstream = new Map(catalog.map((model) => [model.id, model]));
        const providerConfig = new Map(
          [...models.entries()].flatMap(([key, id]) => {
            const model = byUpstream.get(id);
            if (!model) return [];
            const config = configFor(model);
            return Object.keys(config).length > 0 ? [[key, config] as const] : [];
          })
        );
        const capabilities = new Map(
          [...models.entries()].flatMap(([key, id]) => {
            const model = byUpstream.get(id);
            return model ? [[key, capabilitiesFor(model)] as const] : [];
          })
        );
        return {
          ...sourceOf(models),
          providerConfig,
          managedKeys: ["contextWindow", "maxOutputTokens", "free"],
          extra: new Map([["capabilities", capabilities]]),
        };
      }),
      Effect.mapError((cause) => ({ provider: "zro", message: cause.message }))
    ),

  enrich: (ctx, result, outcome) =>
    Effect.gen(function* () {
      const capabilities = Option.match(Option.fromNullishOr(result.extra?.get("capabilities")), {
        onNone: () => new Map<string, Capabilities>(),
        onSome: (value) => value as Map<string, Capabilities>,
      });
      if (capabilities.size === 0 || outcome.added.length === 0) return [] as ReadonlyArray<string>;

      let marked = 0;
      for (const key of outcome.added) {
        const found = entryFor(ctx.modelsDir, key);
        if (found._tag === "None") continue;
        const capability = capabilities.get(key);
        if (!capability) continue;

        let changed = false;
        if (found.value.data.reasoning === undefined) {
          found.value.data.reasoning = capability.reasoning;
          changed = true;
        }
        if (capability.modalities && !found.value.data.modalities) {
          found.value.data.modalities = capability.modalities;
          changed = true;
        }
        if (!changed) continue;
        yield* writeEntry(found.value, found.value.data);
        marked += 1;
      }

      return marked > 0 ? [`[Zro] marked ${marked} model(s) with catalog capabilities`] : [];
    }),
};
