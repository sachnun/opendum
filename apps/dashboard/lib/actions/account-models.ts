"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import {
  providerAccount,
  providerAccountDisabledModel,
} from "@opendum/shared/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import {
  resolveModelAlias,
  getProviderModelSet,
  getModelLookupKeys,
} from "@opendum/shared/proxy/models";

export type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Enable or disable a model for a specific provider account.
 * Only models supported by the account's provider can be toggled.
 */
export async function setAccountModelEnabled(
  accountId: string,
  modelId: string,
  enabled: boolean
): Promise<ActionResult<{ model: string; enabled: boolean }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  // Verify account ownership
  const [account] = await db
    .select({
      id: providerAccount.id,
      provider: providerAccount.provider,
    })
    .from(providerAccount)
    .where(
      and(
        eq(providerAccount.id, accountId),
        eq(providerAccount.userId, session.user.id)
      )
    )
    .limit(1);

  if (!account) {
    return { success: false, error: "Account not found" };
  }

  const normalizedModel = resolveModelAlias(modelId.trim());
  if (!normalizedModel) {
    return { success: false, error: "Invalid model" };
  }

  // Verify the model is supported by this provider
  const providerModels = getProviderModelSet(account.provider);
  if (!providerModels.has(normalizedModel)) {
    return {
      success: false,
      error: `Model "${normalizedModel}" is not supported by provider "${account.provider}"`,
    };
  }

  try {
    if (enabled) {
      // Enable = remove from disabled list (including aliases)
      const modelLookupKeys = getModelLookupKeys(normalizedModel);
      await db
        .delete(providerAccountDisabledModel)
        .where(
          and(
            eq(providerAccountDisabledModel.providerAccountId, accountId),
            inArray(providerAccountDisabledModel.model, modelLookupKeys)
          )
        );
    } else {
      // Disable = add to disabled list
      await db
        .insert(providerAccountDisabledModel)
        .values({
          providerAccountId: accountId,
          model: normalizedModel,
        })
        .onConflictDoNothing({
          target: [
            providerAccountDisabledModel.providerAccountId,
            providerAccountDisabledModel.model,
          ],
        });
    }

    revalidatePath("/dashboard", "layout");
    revalidatePath("/dashboard/accounts");

    return {
      success: true,
      data: {
        model: normalizedModel,
        enabled,
      },
    };
  } catch (error) {
    console.error("Failed to update account model status:", error);
    return { success: false, error: "Failed to update model status" };
  }
}

/**
 * Bulk update disabled models for a provider account.
 * Replaces all disabled models with the provided list.
 */
export async function setAccountDisabledModels(
  accountId: string,
  disabledModels: string[]
): Promise<ActionResult<{ disabledModels: string[] }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  // Verify account ownership
  const [account] = await db
    .select({
      id: providerAccount.id,
      provider: providerAccount.provider,
    })
    .from(providerAccount)
    .where(
      and(
        eq(providerAccount.id, accountId),
        eq(providerAccount.userId, session.user.id)
      )
    )
    .limit(1);

  if (!account) {
    return { success: false, error: "Account not found" };
  }

  const providerModels = getProviderModelSet(account.provider);

  // Normalize and validate all models
  const normalizedModels = disabledModels
    .map((m) => resolveModelAlias(m.trim()))
    .filter((m) => m.length > 0 && providerModels.has(m));
  const uniqueModels = Array.from(new Set(normalizedModels));

  try {
    // Delete all existing disabled models for this account
    await db
      .delete(providerAccountDisabledModel)
      .where(eq(providerAccountDisabledModel.providerAccountId, accountId));

    // Insert the new disabled models
    if (uniqueModels.length > 0) {
      await db.insert(providerAccountDisabledModel).values(
        uniqueModels.map((model) => ({
          providerAccountId: accountId,
          model,
        }))
      );
    }

    revalidatePath("/dashboard", "layout");
    revalidatePath("/dashboard/accounts");

    return {
      success: true,
      data: { disabledModels: uniqueModels },
    };
  } catch (error) {
    console.error("Failed to update account disabled models:", error);
    return { success: false, error: "Failed to update model access" };
  }
}
