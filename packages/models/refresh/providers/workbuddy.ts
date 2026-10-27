import { Effect, Option, Schema, Cause } from "effect";
import { raise } from "@opendum/models/refresh/core/raise";
import { parseJson } from "@opendum/models/refresh/core/json";
import { buildIndex } from "@opendum/models/model-store";
import { exists, readText } from "@opendum/models/fs";
import { join } from "@opendum/models/paths";
import { env } from "@opendum/models/refresh/core/env";
import { entryFor, writeEntry } from "@opendum/models/refresh/core/keys";
import { fetchJson } from "@opendum/models/sync/http";
import { causeMessage } from "@opendum/models/refresh/core/failure";
import type { ModelFetchFailure, ModelTimeoutFailure } from "@opendum/models/errors";
import { sourceOf, type ModelSource, type SourceContext, type SourceResult } from "@opendum/models/refresh/core/types";
import { compareText } from "@opendum/models/compare";

const PROVIDER = "workbuddy";
const NPM_PACKAGE = "@tencent-ai/codebuddy-code";
const PRODUCT_FILE = "product.json";
const MIN_EXPECTED_MODELS = 20;
const HOUSE_MODEL = /(?:^|-)model$/;
const NPM_REGISTRY = "https://registry.npmjs.org";
const UNPKG = "https://unpkg.com";

const Entry = Schema.Struct({ id: Schema.String, supportsReasoning: Schema.optional(Schema.Boolean) });
const Payload = Schema.Struct({ models: Schema.Array(Schema.Unknown) });

const decodeEntry = Schema.decodeUnknownOption(Entry);
const decodePayload = Schema.decodeUnknownOption(Payload);

type Entry = typeof Entry.Type;

const excluded = (id: string): boolean => id.includes("image") || id.startsWith("hunyuan-video");

const toEntry = (value: unknown): Option.Option<Entry> =>
  Option.flatMap(decodeEntry(value), (entry) =>
    excluded(entry.id) ? Option.none() : Option.some(entry)
  );

type RemoteFailure = ModelFetchFailure | ModelTimeoutFailure;

const remoteVersion = (): Effect.Effect<string, RemoteFailure> =>
  fetchJson(`${NPM_REGISTRY}/${NPM_PACKAGE}/latest`, { label: `${NPM_PACKAGE} npm metadata` }).pipe(
    Effect.map((manifest) =>
      Option.getOrElse(
        Schema.decodeUnknownOption(Schema.Struct({ version: Schema.String }))(manifest),
        () => ({ version: "" })
      ).version
    ),
    Effect.flatMap((version) =>
      version ? Effect.succeed(version) : Effect.die(new Error(`could not read the version of ${NPM_PACKAGE}`))
    )
  );

const remoteCatalog = (): Effect.Effect<ReadonlyArray<Entry>, RemoteFailure> =>
  Effect.gen(function* () {
    const version = yield* remoteVersion();
    const payload = yield* fetchJson(`${UNPKG}/${NPM_PACKAGE}@${version}/${PRODUCT_FILE}`, {
      label: `${NPM_PACKAGE} product catalog`,
    });
    const models = Option.match(decodePayload(payload), {
      onNone: () => [] as ReadonlyArray<unknown>,
      onSome: (value) => value.models,
    });
    if (models.length === 0) raise(new Error(`unexpected models payload in ${NPM_PACKAGE}@${version}`));
    return models.flatMap((item) => Option.match(toEntry(item), { onNone: () => [], onSome: (entry) => [entry] }));
  });

const localCatalog = (): ReadonlyArray<Entry> => {
  const home = env("HOME");
  if (!home) return [];
  const candidate = join(home, ".workbuddy-ai", "cache", "acc-product-config-v3.json");
  if (!exists(candidate)) return [];

  const payload: unknown = parseJson(readText(candidate));
  const models = Array.isArray(payload)
    ? payload
    : Option.getOrElse(decodePayload(payload), () => ({ models: [] as ReadonlyArray<unknown> })).models;
  return models.flatMap((item) => Option.match(toEntry(item), { onNone: () => [], onSome: (entry) => [entry] }));
};

const ignoredTargets = (modelsDir: string): ReadonlyArray<{ key: string; entry: ReturnType<typeof entryFor> }> =>
  Object.values(buildIndex(modelsDir))
    .flatMap((entry) => {
      const key = entry.id || entry.fileId;
      if (!key || !HOUSE_MODEL.test(key)) return [];
      if (entry.data.ignored === true) return [];
      const providers = entry.data.providers ?? [];
      if (providers.length > 0 && !providers.every((provider) => provider === PROVIDER)) return [];
      return [{ key, entry: entryFor(modelsDir, key) }];
    });

const registeredCatalog = (modelsDir: string): ReadonlyMap<string, string> => {
  const models = new Map<string, string>();
  for (const [modelId, entry] of Object.entries(buildIndex(modelsDir))) {
    if (!(entry.data.providers ?? []).includes(PROVIDER)) continue;
    const key = entry.id || modelId;
    models.set(key, key);
  }
  return models;
};

const degraded = (
  ctx: SourceContext,
  cause: ModelFetchFailure | ModelTimeoutFailure
): Effect.Effect<SourceResult> =>
  Effect.andThen(
    Effect.logWarning(
      `[WorkBuddy] catalog unavailable (${causeMessage(Cause.fail(cause))}); keeping the registered models`
    ),
    Effect.sync(() => sourceOf(registeredCatalog(ctx.modelsDir)) as SourceResult)
  );

export const workbuddySource: ModelSource = {
  provider: PROVIDER,
  label: "WorkBuddy",
  order: 80,
  phase: "fetch",

  fetch: (ctx) =>
    remoteCatalog().pipe(
      Effect.map((remote): SourceResult => {
        const models = new Map<string, string>();
        const reasoning = new Map<string, boolean>();
        for (const entry of [...remote, ...localCatalog()]) {
          if (models.has(entry.id)) continue;
          models.set(entry.id, entry.id);
          reasoning.set(entry.id, entry.supportsReasoning === true);
        }
        if (models.size === 0) raise(new Error("WorkBuddy catalog produced no models"));
        if (models.size < MIN_EXPECTED_MODELS) {
          console.warn(`[WorkBuddy] only ${models.size} models (expected >= ${MIN_EXPECTED_MODELS})`);
        }
        const sorted = new Map([...models.entries()].sort(([left], [right]) => compareText(left, right)));
        return { ...sourceOf(sorted), extra: new Map([["reasoning", reasoning]]) };
      }),
      Effect.catchTags({
        ModelFetchFailure: (cause) => degraded(ctx, cause),
        ModelTimeoutFailure: (cause) => degraded(ctx, cause),
      }),
      Effect.mapError((cause: unknown) => ({
        provider: PROVIDER,
        message: cause instanceof Error ? cause.message : String(cause),
      }))
    ),

  enrich: (ctx, result, outcome) =>
    Effect.gen(function* () {
      const reasoning = Option.match(Option.fromNullishOr(result.extra?.get("reasoning")), {
        onNone: () => new Map<string, boolean>(),
        onSome: (value) => value as Map<string, boolean>,
      });

      let marked = 0;
      for (const key of outcome.added) {
        const found = entryFor(ctx.modelsDir, key);
        if (found._tag === "None") continue;
        const value = reasoning.get(key);
        if (value === undefined) continue;
        if (found.value.data.reasoning === value) continue;
        found.value.data.reasoning = value;
        yield* writeEntry(found.value, found.value.data);
        marked += 1;
      }

      let ignored = 0;
      for (const target of ignoredTargets(ctx.modelsDir)) {
        if (target.entry._tag === "None") continue;
        target.entry.value.data.ignored = true;
        yield* writeEntry(target.entry.value, target.entry.value.data);
        ignored += 1;
      }

      const notes: string[] = [];
      if (marked > 0) notes.push(`[WorkBuddy] refreshed reasoning flags for ${marked} model(s)`);
      if (ignored > 0) notes.push(`[WorkBuddy] ignored ${ignored} house model(s)`);
      return notes;
    }),
};
