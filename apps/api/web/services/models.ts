import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type { ModelListItem, ModelSearchItem, ModelStatsData, ModelStatsInput, EnableModelInput, EnableModelResult } from "@opendum/providers/contract";
import { db, disabledModel } from "@opendum/database";
import { statsByModel } from "@opendum/api/web/lib/model-stats";
import { modelAvailability, invalidateDisabled, usable, type AccountModelAvailability } from "@opendum/api/web/lib/proxy/auth";
import { MODEL_REGISTRY, allModels, familyOf, keysOf, providersFor, supportsModel, aliasOf } from "@opendum/api/web/lib/proxy/models";
import { compareEntries } from "@opendum/models/sort";
import { fromEffect, fromPromise } from "@opendum/api/web/lib/task";
import { internal } from "@opendum/api/web/errors";

function modelInfo(model: string) {
  const info = MODEL_REGISTRY[model];
  return {
    reasoning: info?.reasoning ?? undefined,
    modalities: info?.modalities ? { input: info.modalities.input ?? [], output: info.modalities.output ?? [] } : undefined,
    cost: info?.cost ?? undefined,
  };
}

const availableFor = Effect.fn("models.availableFor")(function* (
  userId: string
) {
  const [disabledModels, availability] = yield* Effect.all(
    [
      fromPromise(
        () =>
          db
            .select({ model: disabledModel.model })
            .from(disabledModel)
            .where(eq(disabledModel.userId, userId)),
        "Failed to load disabled models"
      ),
      modelAvailability(userId),
    ],
    { concurrency: "unbounded" }
  );

  return {
    availability,
    disabledModelSet: new Set(disabledModels.map((entry) => {
      const model = entry.model.trim();
      const canonical = aliasOf(model);
      return supportsModel(canonical) ? canonical : model;
    })),
    models: allModels()
      .filter((model) => usable(model, availability))
      .sort((a, b) => compareEntries({ id: a, family: familyOf(a) }, { id: b, family: familyOf(b) })),
  };
});

function modelProviders(model: string, availability: AccountModelAvailability, options: { all?: boolean } = {}): string[] {
  const canonical = aliasOf(model);
  if (options.all) return providersFor(model);

  const providers = providersFor(model).filter((provider) => availability.activeProviders.has(provider));
  for (const [provider, models] of availability.customProviderModels) {
    if (models.has(canonical) && (availability.accountCountByProvider.get(provider) ?? 0) > 0) providers.push(provider);
  }
  return providers;
}

function customEntries(availability: AccountModelAvailability): Array<{ id: string; slug: string; modelId: string }> {
  const entries: Array<{ id: string; slug: string; modelId: string }> = [];
  for (const [slug, modelIds] of availability.customProviderStandaloneModels) {
    if ((availability.accountCountByProvider.get(slug) ?? 0) === 0) continue;
    for (const modelId of modelIds) entries.push({ id: `${slug}/${modelId}`, slug, modelId });
  }
  return entries;
}

export const listModels = Effect.fn("models.listModels")(function* (
  userId: string,
  options: { includeStats?: boolean } = {}
) {
  return yield* listModelsInner(userId, options).pipe(
    Effect.mapError((failure) => internal("Failed to list models", failure.cause ?? failure))
  );
});

const listModelsInner = Effect.fnUntraced(function* (
  userId: string,
  options: { includeStats?: boolean } = {}
) {
  const includeStats = options.includeStats ?? true;
  const { availability, disabledModelSet, models: availableModels } = yield* availableFor(
    userId
  );
  const availableSet = new Set(availableModels);
  const modelStats = includeStats
    ? yield* fromEffect(statsByModel(userId, availableModels), "Failed to load model stats")
    : ({} as Record<string, ModelStatsData[string]>);

    const result: ModelListItem[] = [
      ...allModels()
        .sort((a, b) => compareEntries({ id: a, family: familyOf(a) }, { id: b, family: familyOf(b) }))
        .map((model): ModelListItem => {
          const available = availableSet.has(model);
          const item: ModelListItem = {
            id: model,
            name: model,
            family: familyOf(model) ?? "Others",
            providers: modelProviders(model, availability, { all: !available }),
            isEnabled: !disabledModelSet.has(model),
            available,
          };
          return Object.assign(
            item,
            modelInfo(model),
            includeStats && available ? { stats: modelStats[model] } : {}
          );
        }),
      ...customEntries(availability).map((entry): ModelListItem => {
        const item: ModelListItem = {
          id: entry.id,
          name: entry.id,
          family: familyOf(entry.modelId) ?? "Others",
          providers: [entry.slug],
          isEnabled: !disabledModelSet.has(entry.id),
          available: true,
          custom: true,
        };
        return Object.assign(item, modelInfo(aliasOf(entry.modelId)));
      }),
    ];
    return result;
});

export function knownModels(): string[] {
  return allModels().sort((left, right) => compareEntries({ id: left, family: familyOf(left) }, { id: right, family: familyOf(right) }));
}

export const searchModels = Effect.fn("models.searchModels")(function* (userId: string) {
  return yield* searchModelsInner(userId).pipe(
    Effect.mapError((failure) => internal("Failed to search models", failure.cause ?? failure))
  );
});

const searchModelsInner = Effect.fnUntraced(function* (userId: string) {
    const { availability, disabledModelSet, models } = yield* availableFor(userId);

    return [
      ...models.map((model): ModelSearchItem => {
        const item: ModelSearchItem = {
          id: model,
          providers: modelProviders(model, availability),
          isEnabled: !disabledModelSet.has(model),
        };
        return Object.assign(item, modelInfo(model));
      }),
      ...customEntries(availability).map((entry): ModelSearchItem => ({
        id: entry.id,
        providers: [entry.slug],
        isEnabled: !disabledModelSet.has(entry.id),
        custom: true,
      })),
    ] satisfies ModelSearchItem[];
});

export const getModelStats = Effect.fn("models.getModelStats")(function* (
  userId: string,
  input: ModelStatsInput
) {
  const { models } = yield* availableFor(userId);
  const availableModelSet = new Set(models);
  const requestedModels = Array.from(
    new Set(
      input.models
        .map((model) => aliasOf(model.trim()))
        .filter((model) => model && supportsModel(model) && availableModelSet.has(model))
    )
  );

  if (requestedModels.length === 0) return {} as ModelStatsData;

  return yield* fromEffect(
    statsByModel(userId, requestedModels),
    "Failed to load model stats"
  ).pipe(Effect.mapError((failure) => internal(failure.message, failure.cause)));
});

export function familyCounts() {
  return allModels().reduce<Record<string, number>>((counts, model) => {
    const family = familyOf(model) ?? "Others";
    counts[family] = (counts[family] ?? 0) + 1;
    return counts;
  }, {});
}

export const enableModel = Effect.fn("models.enableModel")(function* (
  userId: string,
  input: EnableModelInput
) {
  return yield* enableInner(userId, input).pipe(
    Effect.catch((failure) =>
      Effect.succeed({
        success: false,
        error: failure.message === "Model not found" ? failure.message : "Failed to update model status",
      } as const satisfies EnableModelResult)
    )
  );
});

const enableInner = Effect.fnUntraced(function* (
  userId: string,
  input: EnableModelInput
) {
  const modelId = input.modelId.trim();

  const canonical = aliasOf(modelId);
  const normalizedModel = supportsModel(canonical)
    ? canonical
    : customEntries(yield* modelAvailability(userId)).find((entry) => entry.id === modelId)
        ?.id;
  if (!normalizedModel) {
    return { success: false, error: "Model not found" } as const satisfies EnableModelResult;
  }

  const lookupKeys = supportsModel(canonical) ? keysOf(normalizedModel) : [normalizedModel];
  yield* fromPromise(
    () =>
      db
        .delete(disabledModel)
        .where(and(eq(disabledModel.userId, userId), inArray(disabledModel.model, lookupKeys))),
    "Failed to update model status"
  );
  if (!input.enabled) {
    yield* fromPromise(
      () =>
        db
          .insert(disabledModel)
          .values({ userId, model: normalizedModel })
          .onConflictDoNothing({ target: [disabledModel.userId, disabledModel.model] }),
      "Failed to update model status"
    );
  }

  yield* invalidateDisabled(userId);

  return {
    success: true,
    data: { model: normalizedModel, enabled: input.enabled },
  } as const satisfies EnableModelResult;
});
