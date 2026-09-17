import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";

import { db, disabledModel } from "@opendum/database";
import { getModelStatsByModel } from "../lib/model-stats";
import { getAccountModelAvailability, invalidateDisabledModelsCache, isModelUsableByAccounts, type AccountModelAvailability } from "../lib/proxy/auth";
import { MODEL_REGISTRY, getAllModels, getModelFamily, getModelLookupKeys, getProvidersForModel, isModelSupported, resolveModelAlias } from "../lib/proxy/models";
import { compareModelEntries } from "../../lib/model-sort";

export const setModelEnabledInputSchema = z.object({ modelId: z.string(), enabled: z.boolean() });
const statsIdsQuerySchema = z.preprocess((value) => (Array.isArray(value) ? value : value == null ? [] : [value]), z.array(z.string().min(1)).max(50));
const statsCursorsQuerySchema = z.preprocess((value) => (Array.isArray(value) ? value : value == null ? [] : [value]), z.array(z.string()).max(50)).optional();

export const modelStatsInputSchema = z.object({ ids: statsIdsQuerySchema, cursors: statsCursorsQuerySchema }).transform(({ ids, cursors }) => ({
  models: ids,
  cursors: cursors ? Object.fromEntries(ids.map((id, index) => [id, cursors[index] ?? ""])) : undefined,
}));

function hashModelStatsValue(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 16);
}

async function getAvailableModelsForUser(userId: string) {
  const [disabledModels, availability] = await Promise.all([
    db.select({ model: disabledModel.model }).from(disabledModel).where(eq(disabledModel.userId, userId)),
    getAccountModelAvailability(userId),
  ]);

  return {
    availability,
    disabledModelSet: new Set(disabledModels.map((entry) => resolveModelAlias(entry.model))),
    models: getAllModels()
      .filter((model) => isModelUsableByAccounts(model, availability))
      .sort((a, b) => compareModelEntries({ id: a, family: getModelFamily(a) }, { id: b, family: getModelFamily(b) })),
  };
}

function modelProviders(model: string, availability: AccountModelAvailability): string[] {
  const canonical = resolveModelAlias(model);
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

export async function listModels(userId: string, options: { includeStats?: boolean } = {}) {
  try {
    const includeStats = options.includeStats ?? true;
    const { availability, disabledModelSet, models } = await getAvailableModelsForUser(userId);
    const statsByModel = includeStats ? await getModelStatsByModel(userId, models) : {};

    const result = [
      ...models.map((model) => ({
        id: model,
        name: model,
        family: getModelFamily(model),
        providers: modelProviders(model, availability),
        reasoning: MODEL_REGISTRY[model]?.reasoning,
        modalities: MODEL_REGISTRY[model]?.modalities,
        cost: MODEL_REGISTRY[model]?.cost,
        isEnabled: !disabledModelSet.has(model),
        ...(includeStats ? { stats: statsByModel[model] } : {}),
      })),
      ...customModelEntries(availability).map((entry) => {
        const canonical = resolveModelAlias(entry.modelId);
        return {
          id: entry.id,
          name: entry.id,
          family: getModelFamily(entry.modelId),
          providers: [entry.slug],
          reasoning: MODEL_REGISTRY[canonical]?.reasoning,
          modalities: MODEL_REGISTRY[canonical]?.modalities,
          cost: MODEL_REGISTRY[canonical]?.cost,
          isEnabled: true,
          custom: true,
        };
      }),
    ];
    return result;
  } catch (error) {
    console.error("Failed to list models:", error);
    throw new Error("Failed to list models", { cause: error });
  }
}

export async function searchModels(userId: string) {
  try {
    const { availability, disabledModelSet, models } = await getAvailableModelsForUser(userId);

    return [
      ...models.map((model) => ({
        id: model,
        providers: modelProviders(model, availability),
        reasoning: MODEL_REGISTRY[model]?.reasoning,
        modalities: MODEL_REGISTRY[model]?.modalities,
        cost: MODEL_REGISTRY[model]?.cost,
        isEnabled: !disabledModelSet.has(model),
      })),
      ...customModelEntries(availability).map((entry) => ({
        id: entry.id,
        providers: [entry.slug],
        isEnabled: true,
        custom: true,
      })),
    ];
  } catch (error) {
    console.error("Failed to search models:", error);
    throw new Error("Failed to search models", { cause: error });
  }
}

export async function getModelStats(userId: string, input: z.infer<typeof modelStatsInputSchema>) {
  try {
    const { models } = await getAvailableModelsForUser(userId);
    const availableModelSet = new Set(models);
    const requestedModels = Array.from(new Set(
      input.models
        .map((model) => resolveModelAlias(model.trim()))
        .filter((model) => model && isModelSupported(model) && availableModelSet.has(model))
    ));

    if (requestedModels.length === 0) return { delta: true, cursors: {} };

    const stats = await getModelStatsByModel(userId, requestedModels);
    const cursors = Object.fromEntries(Object.entries(stats).map(([model, value]) => [model, hashModelStatsValue(value)]));
    const changedStats = Object.fromEntries(Object.entries(stats).filter(([model, value]) => input.cursors?.[model] !== hashModelStatsValue(value)));

    return {
      delta: true,
      cursors,
      ...(Object.keys(changedStats).length > 0 ? { stats: changedStats } : {}),
    };
  } catch (error) {
    console.error("Failed to load model stats:", error);
    throw new Error("Failed to load model stats", { cause: error });
  }
}

export async function getModelFamilyCounts(userId: string) {
  try {
    const { availability, models } = await getAvailableModelsForUser(userId);
    const counts = models.reduce<Record<string, number>>((accumulator, model) => {
      const family = getModelFamily(model) ?? "Others";
      accumulator[family] = (accumulator[family] ?? 0) + 1;
      return accumulator;
    }, {});
    for (const entry of customModelEntries(availability)) {
      const family = getModelFamily(entry.modelId) ?? "Others";
      counts[family] = (counts[family] ?? 0) + 1;
    }
    return counts;
  } catch (error) {
    console.error("Failed to count model families:", error);
    throw new Error("Failed to count model families", { cause: error });
  }
}

export async function setModelEnabled(userId: string, input: z.infer<typeof setModelEnabledInputSchema>) {
  const normalizedModel = resolveModelAlias(input.modelId.trim());

  if (!normalizedModel || !isModelSupported(normalizedModel)) {
    return { success: false, error: "Model not found" } as const;
  }

  try {
    await db.delete(disabledModel).where(and(eq(disabledModel.userId, userId), inArray(disabledModel.model, getModelLookupKeys(normalizedModel))));
    if (!input.enabled) await db.insert(disabledModel).values({ userId, model: normalizedModel }).onConflictDoNothing({ target: [disabledModel.userId, disabledModel.model] });

    await invalidateDisabledModelsCache(userId);

    return { success: true, data: { model: normalizedModel, enabled: input.enabled } } as const;
  } catch (error) {
    console.error("Failed to update model status:", error);
    return { success: false, error: "Failed to update model status" } as const;
  }
}
