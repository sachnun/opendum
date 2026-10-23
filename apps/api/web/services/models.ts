import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type { ModelListItem, ModelSearchItem, ModelStatsData, ModelStatsInput, SetModelEnabledInput, SetModelEnabledResult } from "@opendum/providers/contract";
import { db, disabledModel } from "@opendum/database";
import { getModelStatsByModel } from "#web/lib/model-stats.js";
import { getAccountModelAvailability, invalidateDisabledModelsCache, usable, type AccountModelAvailability } from "#web/lib/proxy/auth.js";
import { MODEL_REGISTRY, getAllModels, getModelFamily, getModelLookupKeys, getProvidersForModel, isModelSupported, resolveModelAlias } from "#web/lib/proxy/models.js";
import { compareModelEntries } from "@opendum/models/sort";
import { fromPromise } from "#web/lib/task.js";
import { internal } from "#web/errors.js";

function modelInfo(model: string) {
  const info = MODEL_REGISTRY[model];
  return {
    reasoning: info?.reasoning ?? undefined,
    modalities: info?.modalities ? { input: info.modalities.input ?? [], output: info.modalities.output ?? [] } : undefined,
    cost: info?.cost ?? undefined,
  };
}

const getAvailableModelsForUser = Effect.fn("models.getAvailableModelsForUser")(function* (
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
      getAccountModelAvailability(userId),
    ],
    { concurrency: "unbounded" }
  );

  return {
    availability,
    disabledModelSet: new Set(disabledModels.map((entry) => {
      const model = entry.model.trim();
      const canonical = resolveModelAlias(model);
      return isModelSupported(canonical) ? canonical : model;
    })),
    models: getAllModels()
      .filter((model) => usable(model, availability))
      .sort((a, b) => compareModelEntries({ id: a, family: getModelFamily(a) }, { id: b, family: getModelFamily(b) })),
  };
});

function modelProviders(model: string, availability: AccountModelAvailability, options: { all?: boolean } = {}): string[] {
  const canonical = resolveModelAlias(model);
  if (options.all) return getProvidersForModel(model);

  const providers = getProvidersForModel(model).filter((provider) => availability.activeProviders.has(provider));
  for (const [provider, models] of availability.customProviderModels) {
    if (models.has(canonical) && (availability.accountCountByProvider.get(provider) ?? 0) > 0) providers.push(provider);
  }
  return providers;
}

function customModelEntries(availability: AccountModelAvailability): Array<{ id: string; slug: string; modelId: string }> {
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
  const { availability, disabledModelSet, models: availableModels } = yield* getAvailableModelsForUser(
    userId
  );
  const availableSet = new Set(availableModels);
  const statsByModel = includeStats
    ? yield* getModelStatsByModel(userId, availableModels)
    : ({} as Record<string, ModelStatsData[string]>);

    const result: ModelListItem[] = [
      ...getAllModels()
        .sort((a, b) => compareModelEntries({ id: a, family: getModelFamily(a) }, { id: b, family: getModelFamily(b) }))
        .map((model): ModelListItem => {
          const available = availableSet.has(model);
          return {
            id: model,
            name: model,
            family: getModelFamily(model) ?? "Others",
            providers: modelProviders(model, availability, { all: !available }),
            ...modelInfo(model),
            isEnabled: !disabledModelSet.has(model),
            available,
            ...(includeStats && available ? { stats: statsByModel[model] } : {}),
          };
        }),
      ...customModelEntries(availability).map((entry): ModelListItem => {
        const canonical = resolveModelAlias(entry.modelId);
        return {
          id: entry.id,
          name: entry.id,
          family: getModelFamily(entry.modelId) ?? "Others",
          providers: [entry.slug],
          ...modelInfo(canonical),
          isEnabled: !disabledModelSet.has(entry.id),
          available: true,
          custom: true,
        };
      }),
    ];
    return result;
});

export function listKnownModels(): string[] {
  return getAllModels().sort((left, right) => compareModelEntries({ id: left, family: getModelFamily(left) }, { id: right, family: getModelFamily(right) }));
}

export const searchModels = Effect.fn("models.searchModels")(function* (userId: string) {
  return yield* searchModelsInner(userId).pipe(
    Effect.mapError((failure) => internal("Failed to search models", failure.cause ?? failure))
  );
});

const searchModelsInner = Effect.fnUntraced(function* (userId: string) {
    const { availability, disabledModelSet, models } = yield* getAvailableModelsForUser(userId);

    return [
      ...models.map((model): ModelSearchItem => ({
        id: model,
        providers: modelProviders(model, availability),
        ...modelInfo(model),
        isEnabled: !disabledModelSet.has(model),
      })),
      ...customModelEntries(availability).map((entry): ModelSearchItem => ({
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
  const { models } = yield* getAvailableModelsForUser(userId);
  const availableModelSet = new Set(models);
  const requestedModels = Array.from(
    new Set(
      input.models
        .map((model) => resolveModelAlias(model.trim()))
        .filter((model) => model && isModelSupported(model) && availableModelSet.has(model))
    )
  );

  if (requestedModels.length === 0) return {} as ModelStatsData;

  return yield* getModelStatsByModel(userId, requestedModels).pipe(
    Effect.mapError((failure) => internal("Failed to load model stats", failure.cause ?? failure))
  );
});

export function getModelFamilyCounts() {
  return getAllModels().reduce<Record<string, number>>((counts, model) => {
    const family = getModelFamily(model) ?? "Others";
    counts[family] = (counts[family] ?? 0) + 1;
    return counts;
  }, {});
}

export const setModelEnabled = Effect.fn("models.setModelEnabled")(function* (
  userId: string,
  input: SetModelEnabledInput
) {
  return yield* setModelEnabledInner(userId, input).pipe(
    Effect.catch((failure) =>
      Effect.succeed({
        success: false,
        error: failure.message === "Model not found" ? failure.message : "Failed to update model status",
      } as const satisfies SetModelEnabledResult)
    )
  );
});

const setModelEnabledInner = Effect.fnUntraced(function* (
  userId: string,
  input: SetModelEnabledInput
) {
  const modelId = input.modelId.trim();

  const canonical = resolveModelAlias(modelId);
  const normalizedModel = isModelSupported(canonical)
    ? canonical
    : customModelEntries(yield* getAccountModelAvailability(userId)).find((entry) => entry.id === modelId)
        ?.id;
  if (!normalizedModel) {
    return { success: false, error: "Model not found" } as const satisfies SetModelEnabledResult;
  }

  const lookupKeys = isModelSupported(canonical) ? getModelLookupKeys(normalizedModel) : [normalizedModel];
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

  yield* invalidateDisabledModelsCache(userId);

  return {
    success: true,
    data: { model: normalizedModel, enabled: input.enabled },
  } as const satisfies SetModelEnabledResult;
});
