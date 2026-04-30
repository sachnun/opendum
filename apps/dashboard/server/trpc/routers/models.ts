import { db } from "../../lib/db";
import { disabledModel } from "../../lib/db/schema";
import { getModelStatsByModel } from "../../lib/model-stats";
import { getAccountModelAvailability, invalidateDisabledModelsCache, isModelUsableByAccounts } from "../../lib/proxy/auth";
import { MODEL_REGISTRY, getAllModels, getModelFamily, getModelLookupKeys, getProvidersForModel, isModelSupported, resolveModelAlias } from "../../lib/proxy/models";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure, router } from "../init";

export const modelsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    try {
      const [disabledModels, availability] = await Promise.all([
        db.select({ model: disabledModel.model }).from(disabledModel).where(eq(disabledModel.userId, ctx.userId)),
        getAccountModelAvailability(ctx.userId),
      ]);
      const disabledModelSet = new Set(disabledModels.map((entry) => resolveModelAlias(entry.model)));
      const allModels = getAllModels()
        .filter((model) => isModelUsableByAccounts(model, availability))
        .sort((a, b) => a.localeCompare(b));
      const statsByModel = await getModelStatsByModel(ctx.userId, allModels);

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
  }),

  search: protectedProcedure.query(async ({ ctx }) => {
    try {
      const [disabledModels, availability] = await Promise.all([
        db.select({ model: disabledModel.model }).from(disabledModel).where(eq(disabledModel.userId, ctx.userId)),
        getAccountModelAvailability(ctx.userId),
      ]);
      const disabledModelSet = new Set(disabledModels.map((entry) => resolveModelAlias(entry.model)));
      const allModels = getAllModels()
        .filter((model) => isModelUsableByAccounts(model, availability))
        .sort((a, b) => a.localeCompare(b));
      const statsByModel = await getModelStatsByModel(ctx.userId, allModels);

      return allModels.map((model) => ({
        id: model,
        providers: getProvidersForModel(model).filter((provider) => availability.activeProviders.has(provider)),
        meta: MODEL_REGISTRY[model]?.meta,
        isEnabled: !disabledModelSet.has(model),
        stats: statsByModel[model],
      }));
    } catch (error) {
      console.error("Failed to search models:", error);
      throw new Error("Failed to search models");
    }
  }),

  familyCounts: protectedProcedure.query(async ({ ctx }) => {
    try {
      const availability = await getAccountModelAvailability(ctx.userId);
      return getAllModels()
        .filter((model) => isModelUsableByAccounts(model, availability))
        .reduce<Record<string, number>>((counts, model) => {
          const family = getModelFamily(model);
          counts[family] = (counts[family] ?? 0) + 1;
          return counts;
        }, {});
    } catch (error) {
      console.error("Failed to count model families:", error);
      throw new Error("Failed to count model families");
    }
  }),

  setEnabled: protectedProcedure
    .input(z.object({ modelId: z.string(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const normalizedModel = resolveModelAlias(input.modelId.trim());

      if (!normalizedModel || !isModelSupported(normalizedModel)) {
        return { success: false, error: "Model not found" } as const;
      }

      try {
        if (input.enabled) {
          await db.delete(disabledModel).where(and(eq(disabledModel.userId, ctx.userId), inArray(disabledModel.model, getModelLookupKeys(normalizedModel))));
        } else {
          await db.insert(disabledModel).values({ userId: ctx.userId, model: normalizedModel }).onConflictDoNothing({ target: [disabledModel.userId, disabledModel.model] });
        }

        await invalidateDisabledModelsCache(ctx.userId);

        return { success: true, data: { model: normalizedModel, enabled: input.enabled } } as const;
      } catch (error) {
        console.error("Failed to update model status:", error);
        return { success: false, error: "Failed to update model status" } as const;
      }
    }),
});
