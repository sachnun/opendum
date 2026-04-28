import { db } from "@opendum/shared/db";
import { disabledModel } from "@opendum/shared/db/schema";
import { getAccountModelAvailability, invalidateDisabledModelsCache, isModelUsableByAccounts } from "@opendum/shared/proxy/auth";
import { MODEL_REGISTRY, getAllModels, getModelFamily, getModelLookupKeys, getProvidersForModel, isModelSupported, resolveModelAlias } from "@opendum/shared/proxy/models";
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

      return getAllModels()
        .filter((model) => isModelUsableByAccounts(model, availability))
        .sort((a, b) => a.localeCompare(b))
        .map((model) => ({
          id: model,
          name: model,
          family: getModelFamily(model),
          providers: getProvidersForModel(model).filter((provider) => availability.activeProviders.has(provider)),
          meta: MODEL_REGISTRY[model]?.meta,
          isEnabled: !disabledModelSet.has(model),
        }));
    } catch (error) {
      console.error("Failed to list models:", error);
      throw new Error("Failed to list models");
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
