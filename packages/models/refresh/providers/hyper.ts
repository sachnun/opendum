import { Effect, Option, Schema } from "effect";
import { raise } from "@opendum/models/refresh/sources/raise";
import { fetchJson } from "@opendum/models/sync/http";
import { entryFor, slugify, writeEntry } from "@opendum/models/refresh/sources/keys";
import { sourceOf, type ModelSource, type SourceResult } from "@opendum/models/refresh/sources/types";
import { compareText } from "@opendum/models/compare";

const MODELS_URL = "https://hyper.charm.land/v1/models";
const MIN_EXPECTED_MODELS = 10;

const Entry = Schema.Struct({
  id: Schema.String,
  reasoning: Schema.optional(
    Schema.Struct({ effort_levels: Schema.optional(Schema.Array(Schema.Unknown)) })
  ),
});
const Payload = Schema.Struct({ data: Schema.Array(Schema.Unknown) });

const decodePayload = Schema.decodeUnknownOption(Payload);
const decodeEntry = Schema.decodeUnknownOption(Entry);

type Entry = typeof Entry.Type;

const standardKeyOf = (modelId: string): string => {
  const normalized = slugify(modelId);
  return normalized.endsWith("-free") ? normalized.slice(0, -"-free".length) : normalized;
};

const uniqueKeys = (entries: ReadonlyArray<Entry>): Map<string, string> => {
  const map = new Map<string, string>();
  for (const entry of entries) {
    const full = slugify(entry.id);
    let key = standardKeyOf(entry.id);
    let suffix = 2;
    while (map.has(key) && map.get(key) !== entry.id) {
      key = suffix === 2 ? full : `${full}-${suffix}`;
      suffix += 1;
    }
    map.set(key, entry.id);
  }
  return new Map([...map.entries()].sort(([left], [right]) => compareText(left, right)));
};

const parseModels = (payload: unknown): ReadonlyArray<Entry> => {
  const data = Option.match(decodePayload(payload), {
    onNone: () => [] as ReadonlyArray<unknown>,
    onSome: (value) => value.data,
  });
  if (data.length === 0) raise(new Error("unexpected Hyper /v1/models payload"));

  const parsed = data.flatMap((item) =>
    Option.match(decodeEntry(item), { onNone: () => [], onSome: (entry) => [entry] })
  );
  if (parsed.length === 0) raise(new Error("Hyper /v1/models returned no models"));
  if (parsed.length < MIN_EXPECTED_MODELS) {
    console.warn(`[Hyper] only ${parsed.length} models returned (expected >= ${MIN_EXPECTED_MODELS})`);
  }
  return parsed;
};

const isReasoning = (entry: Entry): boolean => (entry.reasoning?.effort_levels ?? []).length > 0;

export const hyperSource: ModelSource = {
  provider: "hyper",
  label: "Hyper",
  order: 20,
  phase: "fetch",

  fetch: () =>
    fetchJson(MODELS_URL, { label: "Hyper /v1/models" }).pipe(
      Effect.map((payload): SourceResult => {
        const entries = parseModels(payload);
        const models = uniqueKeys(entries);
        const reasoning = new Set(entries.filter(isReasoning).map((entry) => entry.id));
        const reasoningKeys = new Set(
          [...models.entries()].flatMap(([key, id]) => (reasoning.has(id) ? [key] : []))
        );
        return { ...sourceOf(models), extra: new Map([["reasoningKeys", reasoningKeys]]) };
      }),
      Effect.mapError((cause) => ({ provider: "hyper", message: cause.message }))
    ),

  enrich: (ctx, result, outcome) =>
    Effect.gen(function* () {
      const reasoningKeys = Option.match(Option.fromNullishOr(result.extra?.get("reasoningKeys")), {
        onNone: () => new Set<string>(),
        onSome: (value) => value as Set<string>,
      });
      if (reasoningKeys.size === 0 || outcome.added.length === 0) return [] as ReadonlyArray<string>;

      const marked = yield* Effect.forEach(
        outcome.added,
        (key) =>
          Effect.gen(function* () {
            if (!reasoningKeys.has(key)) return null;
            const entry = entryFor(ctx.modelsDir, key);
            if (entry._tag === "None") return null;
            if (entry.value.data.reasoning === true) return null;
            entry.value.data.reasoning = true;
            yield* writeEntry(entry.value, entry.value.data);
            return key;
          }),
        { concurrency: 1 }
      );

      const updated = marked.filter((key): key is string => key !== null);
      return updated.length > 0 ? [`[Hyper] marked ${updated.length} model(s) as reasoning`] : [];
    }),
};
