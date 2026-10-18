import { Effect, Schema } from "effect";

import { ModelParseFailure } from "./errors.ts";
import type { ModelData, ProviderModelConfig } from "./types.ts";

const OptionalString = Schema.optional(Schema.String);
const OptionalBoolean = Schema.optional(Schema.Boolean);
const OptionalNumber = Schema.optional(Schema.Number);
const StringArray = Schema.Array(Schema.String);

export const ProviderConfigSchema = Schema.StructWithRest(
  Schema.Struct({
    upstream: OptionalString,
    contextWindow: OptionalNumber,
    maxOutputTokens: OptionalNumber,
    authless: OptionalBoolean,
    free: OptionalBoolean,
    minTier: OptionalString,
    allowedTiers: Schema.optional(StringArray),
    aliases: Schema.optional(StringArray),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);

export const ModelDataSchema = Schema.StructWithRest(
  Schema.Struct({
    id: OptionalString,
    providers: Schema.optional(StringArray),
    aliases: Schema.optional(StringArray),
    description: OptionalString,
    ignored: OptionalBoolean,
    reasoning: Schema.optional(Schema.NullOr(Schema.Boolean)),
    reasoning_effort: Schema.optional(Schema.NullOr(StringArray)),
    family: OptionalString,
    modalities: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          input: Schema.optional(StringArray),
          output: Schema.optional(StringArray),
        })
      )
    ),
    limit: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          context: OptionalNumber,
          output: OptionalNumber,
        })
      )
    ),
    cost: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          input: OptionalNumber,
          output: OptionalNumber,
          cacheRead: OptionalNumber,
          cacheWrite: OptionalNumber,
        })
      )
    ),
    scores: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          artificialAnalysis: Schema.optional(
            Schema.Struct({
              index: OptionalNumber,
              estimated: OptionalBoolean,
            })
          ),
        })
      )
    ),
    providerConfig: Schema.optional(Schema.Record(Schema.String, ProviderConfigSchema)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);

export type DecodedModelData = typeof ModelDataSchema.Type;

const JsonFromString = Schema.fromJsonString(ModelDataSchema);

function decodeFailure(path: string, message: string, cause: unknown): ModelParseFailure {
  return new ModelParseFailure({ message, path, cause });
}

export function decodeModelData(
  content: string,
  path: string
): Effect.Effect<ModelData, ModelParseFailure> {
  return Schema.decodeUnknownEffect(JsonFromString)(content).pipe(
    Effect.mapError((cause) => decodeFailure(path, `invalid model JSON: ${path}`, cause)),
    Effect.map((data) => data as ModelData)
  );
}

export function decodeModelDataSync(content: string, path: string): ModelData {
  try {
    return Schema.decodeUnknownSync(JsonFromString)(content) as ModelData;
  } catch (cause) {
    throw decodeFailure(path, `invalid model JSON: ${path}`, cause);
  }
}

export function validateModelData(
  data: ModelData,
  path: string
): Effect.Effect<ModelData, ModelParseFailure> {
  return Schema.decodeUnknownEffect(ModelDataSchema)(data).pipe(
    Effect.mapError((cause) => decodeFailure(path, `invalid model data: ${path}`, cause)),
    Effect.map((value) => value as ModelData)
  );
}

export function validateProviderConfig(value: unknown): ProviderModelConfig | null {
  const decoded = Schema.decodeUnknownOption(ProviderConfigSchema)(value);
  return decoded._tag === "Some" ? (decoded.value as ProviderModelConfig) : null;
}

export function validateRegistry(
  value: unknown
): Effect.Effect<ReadonlyArray<ModelData>, ModelParseFailure> {
  return Schema.decodeUnknownEffect(Schema.Array(ModelDataSchema))(value).pipe(
    Effect.mapError((cause) => decodeFailure("<registry>", "invalid model registry payload", cause)),
    Effect.map((items) => items as ReadonlyArray<ModelData>)
  );
}
