import { Chunk, Effect, Match, Option, Schema } from "effect";
import { stripParams } from "@opendum/models/model/clean-key";
import { buildIndex, persist, sync } from "@opendum/models/model-store";
import type { JsonValue, ModelData, ModelIndexEntry } from "@opendum/models/types";
import type { SourceContext, SourceResult, SyncOutcome } from "@opendum/models/refresh/core/types";

const PARAM_SEPARATORS = /[:/]/g;
const UNSAFE_CHARS = /[^a-zA-Z0-9._-]/g;
const REPEATED_DASHES = /-{2,}/g;
const FREE_SUFFIX = "-free";

const decodeResult = Schema.decodeUnknownOption(
  Schema.Struct({
    models: Schema.ReadonlyMap(Schema.String, Schema.String),
    providerConfig: Schema.optional(
      Schema.ReadonlyMap(Schema.String, Schema.Record(Schema.String, Schema.Unknown))
    ),
    managedKeys: Schema.optional(Schema.Array(Schema.String)),
  })
);

export const slugify = (modelId: string): string =>
  modelId
    .replace(PARAM_SEPARATORS, "-")
    .replace(UNSAFE_CHARS, "-")
    .replace(REPEATED_DASHES, "-");

export const withoutPrefix = (modelId: string, prefix: string): string =>
  modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;

export const afterFirstSlash = (modelId: string): string => {
  const index = modelId.indexOf("/");
  return index === -1 ? modelId : modelId.slice(index + 1);
};

export const withoutFreeSuffix = (key: string): string =>
  key.endsWith(FREE_SUFFIX) ? key.slice(0, -FREE_SUFFIX.length) : key;

export const standardKey = (modelId: string): string =>
  withoutFreeSuffix(stripParams(slugify(modelId)));

export const slashedKey = (modelId: string): string => standardKey(afterFirstSlash(modelId));

export const prefixedKey = (modelId: string, prefix: string): string =>
  standardKey(withoutPrefix(modelId, prefix));

export const emptyOutcome: SyncOutcome = { added: [], removed: [], updated: [] };

export const isUnchanged = (outcome: SyncOutcome): boolean =>
  outcome.added.length === 0 && outcome.removed.length === 0 && outcome.updated.length === 0;

const detailLine = (label: string, values: ReadonlyArray<string>): Chunk.Chunk<string> =>
  Match.value(values.length > 0).pipe(
    Match.when(true, () => Chunk.of(`  ${label}: ${values.join(", ")}`)),
    Match.orElse(() => Chunk.empty<string>())
  );

export const report = (label: string, outcome: SyncOutcome, total: number): string =>
  Match.value(isUnchanged(outcome)).pipe(
    Match.when(true, () => `[${label}] models are already up to date (${total} models).`),
    Match.orElse(() =>
      Chunk.toReadonlyArray(
        Chunk.of(
          `[${label}] synced ${total} models (added ${outcome.added.length}, removed ${outcome.removed.length}, updated ${outcome.updated.length}).`
        )
          .pipe(Chunk.appendAll(detailLine("Added", outcome.added)))
          .pipe(Chunk.appendAll(detailLine("Removed", outcome.removed)))
          .pipe(Chunk.appendAll(detailLine("Updated", outcome.updated)))
      ).join("\n")
    )
  );

export const entryFor = (modelsDir: string, key: string): Option.Option<ModelIndexEntry> =>
  Option.fromNullishOr(
    Object.values(buildIndex(modelsDir)).find((item) => item.fileId === key || item.id === key)
  );

export const writeEntry = (
  entry: Pick<ModelIndexEntry, "modelsDir" | "relativeId">,
  data: ModelData
): Effect.Effect<{ authoredPath: string; generatedPath: string }> =>
  Effect.promise(() => persist(entry, data));

const providerConfigOf = (
  config: ReadonlyMap<string, Record<string, unknown>> | undefined
): Option.Option<Map<string, Record<string, JsonValue>>> =>
  Option.map(Option.fromNullishOr(config), (value) =>
    new Map([...value.entries()].map(([key, entry]) => [key, entry as Record<string, JsonValue>]))
  );

const managedKeysOf = (keys: ReadonlyArray<string> | undefined): Option.Option<string[]> =>
  Option.map(Option.fromNullishOr(keys), (value) => [...value]);

const syncOptions = (result: SourceResult): {
  providerConfig?: Map<string, Record<string, JsonValue>>;
  managedProviderConfigKeys?: string[];
} =>
  Option.match(decodeResult(result), {
    onNone: () => ({}),
    onSome: (value) => ({
      ...Option.match(providerConfigOf(value.providerConfig), {
        onNone: () => ({}),
        onSome: (providerConfig) => ({ providerConfig }),
      }),
      ...Option.match(managedKeysOf(value.managedKeys), {
        onNone: () => ({}),
        onSome: (keys) => ({ managedProviderConfigKeys: keys }),
      }),
    }),
  });

export const apply = (
  ctx: SourceContext,
  provider: string,
  result: SourceResult
): Effect.Effect<SyncOutcome> =>
  Effect.tryPromise({
    try: () =>
      sync(ctx.modelsDir, provider, new Map(result.models), {
        ...syncOptions(result),
        dryRun: ctx.flags.dryRun,
      }),
    catch: (cause) => cause,
  }).pipe(Effect.orDie);
