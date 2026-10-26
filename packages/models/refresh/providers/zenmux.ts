import { Effect, Option, Schema } from "effect";
import { raise } from "@opendum/models/refresh/core/raise";
import { idMap } from "@opendum/models/model-store";
import { fetchJson } from "@opendum/models/sync/http";
import { slashedKey } from "@opendum/models/refresh/core/keys";
import type { ModelSource, SourceResult } from "@opendum/models/refresh/core/types";

const PLANS_URL = "https://zenmux.ai/api/subscription/public/get_all_plans";
const MODELS_URL = "https://zenmux.ai/api/v1/models";
const FREE_PLAN_MARKER = "5 Flows/5h";

const Plan = Schema.Struct({
  desc: Schema.optional(Schema.String),
  models: Schema.optional(Schema.Array(Schema.Unknown)),
});

const PlanEntry = Schema.Struct({
  provider_slug: Schema.optional(Schema.String),
  model_slug: Schema.optional(Schema.String),
});

const Plans = Schema.Struct({ data: Schema.Array(Plan) });
const Catalog = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      output_modalities: Schema.optional(Schema.Array(Schema.String)),
    })
  ),
});

const decodePlans = Schema.decodeUnknownOption(Plans);
const decodeCatalog = Schema.decodeUnknownOption(Catalog);
const decodePlanEntry = Schema.decodeUnknownOption(PlanEntry);

const freePlanSlugs = (plans: unknown): ReadonlySet<string> => {
  const parsed = Option.getOrThrowWith(
    decodePlans(plans),
    () => new Error("unexpected ZenMux get_all_plans payload")
  );
  const freePlan = parsed.data.find((plan) => (plan.desc ?? "").includes(FREE_PLAN_MARKER));
  if (!freePlan) raise(new Error(`Free Plan (${FREE_PLAN_MARKER}) not found in ZenMux plans`));

  const slugs = new Set<string>();
  for (const model of freePlan.models ?? []) {
    Option.match(decodePlanEntry(model), {
      onNone: () => undefined,
      onSome: (entry) => {
        if (entry.provider_slug !== "*") return;
        const slug = (entry.model_slug ?? "").trim();
        if (slug) slugs.add(slug);
      },
    });
  }
  if (slugs.size === 0) raise(new Error("no models found in the ZenMux free plan"));
  return slugs;
};

const textOutput = (entry: { output_modalities?: ReadonlyArray<string> }): boolean => {
  const modalities = entry.output_modalities ?? [];
  return modalities.length === 0 || modalities.includes("text");
};

const freeIds = (catalog: unknown, allowed: ReadonlySet<string>): ReadonlyArray<string> => {
  const parsed = Option.getOrThrowWith(
    decodeCatalog(catalog),
    () => new Error("unexpected ZenMux /v1/models payload")
  );
  if (parsed.data.length === 0) raise(new Error("ZenMux returned no models"));

  return [
    ...new Set(
      parsed.data
        .filter((entry) => allowed.has(entry.id) && textOutput(entry))
        .map((entry) => entry.id)
    ),
  ].sort((left, right) => left.localeCompare(right));
};

export const zenmuxSource: ModelSource = {
  provider: "zenmux",
  label: "ZenMux",
  order: 70,
  phase: "fetch",

  fetch: () =>
    Effect.gen(function* () {
      const plans = yield* fetchJson(PLANS_URL, { label: "ZenMux subscription plans" });
      const catalog = yield* fetchJson(MODELS_URL, { label: "ZenMux /v1/models" });
      const models = idMap([...freeIds(catalog, freePlanSlugs(plans))], slashedKey);
      return {
        models,
        providerConfig: new Map([...models.keys()].map((key) => [key, {}])),
      } satisfies SourceResult;
    }).pipe(Effect.mapError((cause) => ({ provider: "zenmux", message: cause.message }))),
};
