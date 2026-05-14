import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { disabledModel } from "../lib/db/schema";
import { getModelStatsByModel } from "../lib/model-stats";
import { getAccountModelAvailability, invalidateDisabledModelsCache, isModelUsableByAccounts } from "../lib/proxy/auth";
import { MODEL_REGISTRY, getAllModels, getModelFamily, getModelLookupKeys, getProvidersForModel, isModelSupported, resolveModelAlias } from "../lib/proxy/models";
import { compareModelEntries } from "../../lib/model-sort";

export const setModelEnabledInputSchema = z.object({ modelId: z.string(), enabled: z.boolean() });

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

export async function listModels(userId: string) {
  try {
    const { availability, disabledModelSet, models } = await getAvailableModelsForUser(userId);
    const statsByModel = await getModelStatsByModel(userId, models);

    return models.map((model) => ({
      id: model,
      name: model,
      family: getModelFamily(model),
      providers: getProvidersForModel(model).filter((provider) => availability.activeProviders.has(provider)),
      meta: MODEL_REGISTRY[model]?.meta,
      isEnabled: !disabledModelSet.has(model),
      stats: statsByModel[model],
    }));
  } catch (error) {
    console.error("Failed to list models:", error);
    throw new Error("Failed to list models");
  }
}

export async function searchModels(userId: string) {
  try {
    const { availability, disabledModelSet, models } = await getAvailableModelsForUser(userId);

    return models.map((model) => ({
      id: model,
      providers: getProvidersForModel(model).filter((provider) => availability.activeProviders.has(provider)),
      meta: MODEL_REGISTRY[model]?.meta,
      isEnabled: !disabledModelSet.has(model),
    }));
  } catch (error) {
    console.error("Failed to search models:", error);
    throw new Error("Failed to search models");
  }
}

export async function getModelFamilyCounts(userId: string) {
  try {
    const { models } = await getAvailableModelsForUser(userId);
    return models.reduce<Record<string, number>>((counts, model) => {
      const family = getModelFamily(model) ?? "Others";
      counts[family] = (counts[family] ?? 0) + 1;
      return counts;
    }, {});
  } catch (error) {
    console.error("Failed to count model families:", error);
    throw new Error("Failed to count model families");
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
