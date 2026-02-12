"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  getModelLookupKeys,
  isModelSupported,
  resolveModelAlias,
} from "@/lib/proxy/models";

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
  const session = await auth();

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
      await prisma.disabledModel.deleteMany({
        where: {
          userId: session.user.id,
          model: { in: modelLookupKeys },
        },
      });
    } else {
      await prisma.disabledModel.upsert({
        where: {
          userId_model: {
            userId: session.user.id,
            model: normalizedModel,
          },
        },
        update: {},
        create: {
          userId: session.user.id,
          model: normalizedModel,
        },
      });
    }

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
