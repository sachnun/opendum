import { Effect, Match, Option, Schema } from "effect";
import { idMap } from "@opendum/models/model-store";
import { fetchDecoded } from "@opendum/models/sync/http";
import { arrayAt, asRecord, stringAt, trimmed } from "@opendum/models/json";
import { slashedKey } from "@opendum/models/refresh/core/keys";
import { sourceOf, type ModelSource, type SourceResult } from "@opendum/models/refresh/core/types";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const SUPPORTED_PARAM_HINTS = ["max_tokens", "temperature", "tools"] as const;

const Model = Schema.Struct({
  id: Schema.String,
  architecture: Schema.optional(
    Schema.Struct({
      input_modalities: Schema.optional(Schema.Array(Schema.String)),
      output_modalities: Schema.optional(Schema.Array(Schema.String)),
    })
  ),
  supported_parameters: Schema.optional(Schema.Array(Schema.String)),
});

const Payload = Schema.Struct({ data: Schema.Array(Schema.Unknown) });

const decodePayload = Schema.decodeUnknownOption(Payload);

function textCapable(model: typeof Model.Type): boolean {
  const input = model.architecture?.input_modalities ?? [];
  const output = model.architecture?.output_modalities ?? [];
  return (input.length === 0 || input.includes("text")) && (output.length === 0 || output.includes("text"));
}

function isFree(model: typeof Model.Type): boolean {
  const freeById = model.id === "openrouter/free" || model.id.endsWith(":free");
  if (!freeById) return false;
  if (!textCapable(model)) return false;
  const supported = model.supported_parameters ?? [];
  return supported.length === 0 || SUPPORTED_PARAM_HINTS.some((hint) => supported.includes(hint));
}

function freeIds(payload: unknown): ReadonlyArray<string> {
  const data = Option.match(decodePayload(payload), {
    onNone: () => arrayAt(payload, "data"),
    onSome: (value) => value.data,
  });
  if (data.length === 0) throw new Error("unexpected OpenRouter /v1/models payload");

  return [
    ...new Set(
      data.flatMap((entry) => {
        const id = Match.value(trimmed(stringAt(entry, "id"))).pipe(
          Match.when(undefined, () => ""),
          Match.orElse((value) => value)
        );
        if (!id) return [];
        const parsed = Schema.decodeUnknownOption(Model)({ ...asRecord(entry), id });
        return Option.match(parsed, {
          onNone: () => [],
          onSome: (model) => (isFree(model) ? [id] : []),
        });
      })
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export const openrouterSource: ModelSource = {
  provider: "openrouter",
  label: "OpenRouter",
  order: 40,
  phase: "fetch",

  fetch: () =>
    fetchDecoded(
      MODELS_URL,
      { label: "OpenRouter free models", headers: { Accept: "application/json" } },
      async (response) => freeIds(await response.json())
    ).pipe(
      Effect.map((ids): SourceResult => sourceOf(idMap([...ids], slashedKey))),
      Effect.mapError((cause) => ({
        provider: "openrouter",
        message: cause.message,
      }))
    ),
};
