import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type { ModelListItem, ModelSearchItem, ModelStatsData, ModelStatsInput, SetModelEnabledInput, SetModelEnabledResult } from "@opendum/providers/contract";
import { db, disabledModel } from "@opendum/database";
import { getModelStatsByModel } from "#web/lib/model-stats.js";
import { getAccountModelAvailability, invalidateDisabledModelsCache, usable, type AccountModelAvailability } from "#web/lib/proxy/auth.js";
import { MODEL_REGISTRY, getAllModels, getModelFamily, getModelLookupKeys, getProvidersForModel, isModelSupported, resolveModelAlias } from "#web/lib/proxy/models.js";
import { compareModelEntries } from "@opendum/models/sort";

function withModelErrors<A>(message: string, run: () => Promise<A>): Promise<A> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: run,
      catch: (cause) => {
        console.error(`${message}:`, cause);
        return new Error(message, { cause });
      },
    })
  );
}

function modelInfo(model: string) {
  const info = MODEL_REGISTRY[model];
  return {
    reasoning: info?.reasoning ?? undefined,
    modalities: info?.modalities ? { input: info.modalities.input ?? [], output: info.modalities.output ?? [] } : undefined,
    cost: info?.cost ?? undefined,
  };
}

async function getAvailableModelsForUser(userId: string) {
  const [disabledModels, availability] = await Promise.all([
    db.select({ model: disabledModel.model }).from(disabledModel).where(eq(disabledModel.userId, userId)),
    getAccountModelAvailability(userId),
  ]);

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
}

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

export function listModels(userId: string, options: { includeStats?: boolean } = {}): Promise<ModelListItem[]> {
  return withModelErrors("Failed to list models", async () => {
    const includeStats = options.includeStats ?? true;
    const { availability, disabledModelSet, models: availableModels } = await getAvailableModelsForUser(userId);
    const availableSet = new Set(availableModels);
    const statsByModel = includeStats ? await getModelStatsByModel(userId, availableModels) : {};

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
}

export function listKnownModels(): string[] {
  return getAllModels().sort((left, right) => compareModelEntries({ id: left, family: getModelFamily(left) }, { id: right, family: getModelFamily(right) }));
}

export function searchModels(userId: string): Promise<ModelSearchItem[]> {
  return withModelErrors("Failed to search models", async () => {
    const { availability, disabledModelSet, models } = await getAvailableModelsForUser(userId);

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
    ];
  });
}

export async function getModelStats(userId: string, input: ModelStatsInput): Promise<ModelStatsData> {
  try {
    const { models } = await getAvailableModelsForUser(userId);
    const availableModelSet = new Set(models);
    const requestedModels = Array.from(new Set(
      input.models
        .map((model) => resolveModelAlias(model.trim()))
        .filter((model) => model && isModelSupported(model) && availableModelSet.has(model))
    ));

    if (requestedModels.length === 0) return {};

    return await getModelStatsByModel(userId, requestedModels);
  } catch (error) {
    console.error("Failed to load model stats:", error);
    throw new Error("Failed to load model stats", { cause: error });
  }
}

export function getModelFamilyCounts() {
  return getAllModels().reduce<Record<string, number>>((counts, model) => {
    const family = getModelFamily(model) ?? "Others";
    counts[family] = (counts[family] ?? 0) + 1;
    return counts;
  }, {});
}

export async function setModelEnabled(userId: string, input: SetModelEnabledInput): Promise<SetModelEnabledResult> {
  const modelId = input.modelId.trim();

  try {
    const canonical = resolveModelAlias(modelId);
    const normalizedModel = isModelSupported(canonical)
      ? canonical
      : customModelEntries((await getAccountModelAvailability(userId))).find((entry) => entry.id === modelId)?.id;
    if (!normalizedModel) return { success: false, error: "Model not found" } as const;

    const lookupKeys = isModelSupported(canonical) ? getModelLookupKeys(normalizedModel) : [normalizedModel];
    await db.delete(disabledModel).where(and(eq(disabledModel.userId, userId), inArray(disabledModel.model, lookupKeys)));
    if (!input.enabled) await db.insert(disabledModel).values({ userId, model: normalizedModel }).onConflictDoNothing({ target: [disabledModel.userId, disabledModel.model] });

    await invalidateDisabledModelsCache(userId);

    return { success: true, data: { model: normalizedModel, enabled: input.enabled } } as const;
  } catch (error) {
    console.error("Failed to update model status:", error);
    return { success: false, error: "Failed to update model status" } as const;
  }
}
