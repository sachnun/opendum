"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import { disabledModel } from "@opendum/shared/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { invalidateDisabledModelsCache } from "@opendum/shared/proxy/auth";
import {
  getModelLookupKeys,
  isModelSupported,
  resolveModelAlias,
} from "@opendum/shared/proxy/models";

export type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string };
/**
 * Enable or disable a model for the current user.
 */
export async function setModelEnabled(
  modelId: string,
  enabled: boolean
): Promise<ActionResult<{ model: string; enabled: boolean }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  const normalizedModel = resolveModelAlias(modelId.trim());

  if (!normalizedModel || !isModelSupported(normalizedModel)) {
    return { success: false, error: "Model not found" };
  }

  try {
    if (enabled) {
      const modelLookupKeys = getModelLookupKeys(normalizedModel);
      await db
        .delete(disabledModel)
        .where(
          and(
            eq(disabledModel.userId, session.user.id),
            inArray(disabledModel.model, modelLookupKeys)
          )
        );
    } else {
      await db
        .insert(disabledModel)
        .values({
          userId: session.user.id,
          model: normalizedModel,
        })
        .onConflictDoNothing({
          target: [disabledModel.userId, disabledModel.model],
        });
    }

    await invalidateDisabledModelsCache(session.user.id);

    revalidatePath("/dashboard", "layout");
    revalidatePath("/dashboard/models");
    revalidatePath("/dashboard/playground");

    return {
      success: true,
      data: {
        model: normalizedModel,
        enabled,
      },
    };
  } catch (error) {
    console.error("Failed to update model status:", error);
    return { success: false, error: "Failed to update model status" };
  }
}
