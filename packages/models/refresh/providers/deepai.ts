import { Effect, Option, Schema } from "effect";
import { raise } from "@opendum/models/refresh/core/raise";
import { idMap } from "@opendum/models/model-store";
import { fetchDecoded } from "@opendum/models/sync/http";
import { standardKey, entryFor, writeEntry } from "@opendum/models/refresh/core/keys";
import { sourceOf, type ModelSource, type SourceResult } from "@opendum/models/refresh/core/types";
import { compareText } from "@opendum/models/compare";

const MODELS_URL = "https://api.deepai.org/deepai_code/models";
const LANE_HEADER = { "X-DeepAI-Code-Theos": "4" };
const EXCLUDED_IDS = new Set(["gpt-oss-120b"]);

const Model = Schema.Struct({
  id: Schema.String,
  reasoning: Schema.optional(Schema.Boolean),
  input: Schema.optional(Schema.Array(Schema.String)),
  contextWindow: Schema.optional(Schema.Number),
  maxTokens: Schema.optional(Schema.Number),
  premier: Schema.optional(Schema.Boolean),
  api: Schema.optional(Schema.String),
});

const Catalog = Schema.Struct({ models: Schema.Array(Schema.Unknown) });

const decodeCatalog = Schema.decodeUnknownOption(Catalog);
const decodeModel = Schema.decodeUnknownOption(Model);

type Model = typeof Model.Type;

type Capabilities = {
  reasoning: boolean;
  modalities: { input: string[]; output: string[] } | null;
};

const textInput = (model: Model): boolean => (model.input ?? ["text"]).includes("text");

const catalogModels = (payload: unknown): ReadonlyArray<Model> => {
  const models = Option.match(decodeCatalog(payload), {
    onNone: () => [] as ReadonlyArray<unknown>,
    onSome: (value) => value.models,
  });
  if (models.length === 0) raise(new Error("unexpected DeepAI model catalog payload"));

  return models
    .flatMap((entry) => Option.match(decodeModel(entry), { onNone: () => [], onSome: (model) => [model] }))
    .filter((model) => !EXCLUDED_IDS.has(model.id) && textInput(model))
    .sort((left, right) => compareText(left.id, right.id));
};

const configFor = (model: Model): Record<string, unknown> => {
  const config: Record<string, unknown> = {};
  if (model.contextWindow && model.contextWindow > 0) config.contextWindow = model.contextWindow;
  if (model.maxTokens && model.maxTokens > 0) config.maxOutputTokens = model.maxTokens;
  if (model.api === "openai-responses") config.responses_api = true;
  if (model.premier !== true) config.free = true;
  return config;
};

const capabilitiesFor = (model: Model): Capabilities => {
  const input = model.input ?? ["text"];
  return {
    reasoning: model.reasoning === true,
    modalities: { input: [...new Set(input)].sort(), output: ["text"] },
  };
};

export const deepaiSource: ModelSource = {
  provider: "deepai",
  label: "DeepAI",
  order: 85,
  phase: "fetch",

  fetch: () =>
    fetchDecoded(
      MODELS_URL,
      { label: "DeepAI model catalog", headers: { Accept: "application/json", ...LANE_HEADER } },
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
          managedKeys: ["contextWindow", "maxOutputTokens", "responses_api", "free"],
          extra: new Map([["capabilities", capabilities]]),
        };
      }),
      Effect.mapError((cause) => ({ provider: "deepai", message: cause.message }))
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

      return marked > 0 ? [`[DeepAI] marked ${marked} model(s) with catalog capabilities`] : [];
    }),
};
