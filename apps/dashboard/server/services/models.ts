import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { disabledModel } from "../lib/db/schema";
import { getModelStatsByModel } from "../lib/model-stats";
import { getAccountModelAvailability, invalidateDisabledModelsCache, isModelUsableByAccounts } from "../lib/proxy/auth";
import { MODEL_REGISTRY, getAllModels, getModelFamily, getModelLookupKeys, getProvidersForModel, isModelSupported, resolveModelAlias } from "../lib/proxy/models";

export const setModelEnabledInputSchema = z.object({ modelId: z.string(), enabled: z.boolean() });

export async function listModels(userId: string) {
  try {
    const [disabledModels, availability] = await Promise.all([
      db.select({ model: disabledModel.model }).from(disabledModel).where(eq(disabledModel.userId, userId)),
      getAccountModelAvailability(userId),
    ]);
    const disabledModelSet = new Set(disabledModels.map((entry) => resolveModelAlias(entry.model)));
    const allModels = getAllModels()
      .filter((model) => isModelUsableByAccounts(model, availability))
      .sort((a, b) => a.localeCompare(b));
    const statsByModel = await getModelStatsByModel(userId, allModels);

    return allModels.map((model) => ({
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
    const [disabledModels, availability] = await Promise.all([
      db.select({ model: disabledModel.model }).from(disabledModel).where(eq(disabledModel.userId, userId)),
      getAccountModelAvailability(userId),
    ]);
    const disabledModelSet = new Set(disabledModels.map((entry) => resolveModelAlias(entry.model)));
    const allModels = getAllModels()
      .filter((model) => isModelUsableByAccounts(model, availability))
      .sort((a, b) => a.localeCompare(b));

    return allModels.map((model) => ({
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
    const availability = await getAccountModelAvailability(userId);
    return getAllModels()
      .filter((model) => isModelUsableByAccounts(model, availability))
      .reduce<Record<string, number>>((counts, model) => {
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
    if (input.enabled) {
      await db.delete(disabledModel).where(and(eq(disabledModel.userId, userId), inArray(disabledModel.model, getModelLookupKeys(normalizedModel))));
    } else {
      await db.insert(disabledModel).values({ userId, model: normalizedModel }).onConflictDoNothing({ target: [disabledModel.userId, disabledModel.model] });
    }

    await invalidateDisabledModelsCache(userId);

    return { success: true, data: { model: normalizedModel, enabled: input.enabled } } as const;
  } catch (error) {
    console.error("Failed to update model status:", error);
    return { success: false, error: "Failed to update model status" } as const;
  }
}
