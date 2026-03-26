"use server";

import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import { proxyApiKey, proxyApiKeyRateLimit, providerAccount } from "@opendum/shared/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { generateApiKey, hashString, getKeyPreview, encrypt, decrypt } from "@opendum/shared/encryption";
import { invalidateApiKeyValidationCache } from "@opendum/shared/proxy/auth";
import { isModelSupported, resolveModelAlias, getAllFamilies } from "@opendum/shared/proxy/models";
import { revalidatePath } from "next/cache";

export type ActionResult<T = void> = 
  | { success: true; data: T }
  | { success: false; error: string };
export type ApiKeyModelAccessMode = "all" | "whitelist" | "blacklist";
export type ApiKeyAccountAccessMode = "all" | "whitelist" | "blacklist";

const API_KEY_MODEL_ACCESS_MODES: ApiKeyModelAccessMode[] = ["all", "whitelist", "blacklist"];
const API_KEY_ACCOUNT_ACCESS_MODES: ApiKeyAccountAccessMode[] = ["all", "whitelist", "blacklist"];

function isApiKeyModelAccessMode(value: string): value is ApiKeyModelAccessMode {
  return API_KEY_MODEL_ACCESS_MODES.includes(value as ApiKeyModelAccessMode);
}

function isApiKeyAccountAccessMode(value: string): value is ApiKeyAccountAccessMode {
  return API_KEY_ACCOUNT_ACCESS_MODES.includes(value as ApiKeyAccountAccessMode);
}

function normalizeModelList(models: string[]): string[] {
  const normalized = models
    .map((model) => resolveModelAlias(model.trim()))
    .filter((model) => model.length > 0);

  return Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b));
}

/**
 * Create a new API key
 */
export async function createApiKey(
  name?: string,
  expiresAt?: Date | null
): Promise<ActionResult<{ id: string; key: string; keyPreview: string; name: string | null; expiresAt: Date | null }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const key = generateApiKey();
    const keyHash = hashString(key);
    const keyPreview = getKeyPreview(key);
    const encryptedKey = encrypt(key);

    const trimmedName = name?.trim() || null;

    const [apiKey] = await db.insert(proxyApiKey).values({
      userId: session.user.id,
      keyHash,
      keyPreview,
      encryptedKey,
      name: trimmedName,
      expiresAt: expiresAt ?? null,
    }).returning();

    revalidatePath("/dashboard/api-keys");

    return {
      success: true,
      data: {
        id: apiKey.id,
        key,
        keyPreview,
        name: apiKey.name,
        expiresAt: apiKey.expiresAt,
      },
    };
  } catch (error) {
    console.error("Failed to create API key:", error);
    return { success: false, error: "Failed to create API key" };
  }
}

/**
 * Toggle API key active status (enable/disable)
 */
export async function toggleApiKey(id: string): Promise<ActionResult> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const [apiKey] = await db.select().from(proxyApiKey).where(and(eq(proxyApiKey.id, id), eq(proxyApiKey.userId, session.user.id))).limit(1);

    if (!apiKey) {
      return { success: false, error: "API key not found" };
    }

    await db.update(proxyApiKey).set({ isActive: !apiKey.isActive }).where(eq(proxyApiKey.id, id));

    await invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);

    revalidatePath("/dashboard/api-keys");

    return { success: true, data: undefined };
  } catch (error) {
    console.error("Failed to toggle API key:", error);
    return { success: false, error: "Failed to toggle API key" };
  }
}

/**
 * Delete an API key permanently
 */
export async function deleteApiKey(id: string): Promise<ActionResult> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const [apiKey] = await db.select().from(proxyApiKey).where(and(eq(proxyApiKey.id, id), eq(proxyApiKey.userId, session.user.id))).limit(1);

    if (!apiKey) {
      return { success: false, error: "API key not found" };
    }

    await db.delete(proxyApiKey).where(eq(proxyApiKey.id, id));

    await invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);

    revalidatePath("/dashboard/api-keys");

    return { success: true, data: undefined };
  } catch (error) {
    console.error("Failed to delete API key:", error);
    return { success: false, error: "Failed to delete API key" };
  }
}

/**
 * Update API key name
 */
export async function updateApiKeyName(id: string, name: string): Promise<ActionResult<{ name: string | null }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const [apiKey] = await db.select().from(proxyApiKey).where(and(eq(proxyApiKey.id, id), eq(proxyApiKey.userId, session.user.id))).limit(1);

    if (!apiKey) {
      return { success: false, error: "API key not found" };
    }

    const trimmedName = name?.trim() || null;

    const [updatedKey] = await db.update(proxyApiKey).set({ name: trimmedName }).where(eq(proxyApiKey.id, id)).returning({ name: proxyApiKey.name });

    revalidatePath("/dashboard/api-keys");

    return { success: true, data: { name: updatedKey.name } };
  } catch (error) {
    console.error("Failed to update API key name:", error);
    return { success: false, error: "Failed to update API key name" };
  }
}

/**
 * Update per-key model access mode and model list
 */
export async function updateApiKeyModelAccess(
  id: string,
  mode: ApiKeyModelAccessMode,
  models: string[]
): Promise<ActionResult<{ mode: ApiKeyModelAccessMode; models: string[] }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  if (!isApiKeyModelAccessMode(mode)) {
    return { success: false, error: "Invalid model access mode" };
  }

  try {
    const [apiKey] = await db.select({ id: proxyApiKey.id, keyHash: proxyApiKey.keyHash }).from(proxyApiKey).where(and(eq(proxyApiKey.id, id), eq(proxyApiKey.userId, session.user.id))).limit(1);

    if (!apiKey) {
      return { success: false, error: "API key not found" };
    }

    const normalizedModels = mode === "all" ? [] : normalizeModelList(models);

    if (mode !== "all" && normalizedModels.length === 0) {
      return { success: false, error: "Select at least one model" };
    }

    const invalidModels = normalizedModels.filter((model) => !isModelSupported(model));
    if (invalidModels.length > 0) {
      return {
        success: false,
        error: `Unknown model: ${invalidModels[0]}`,
      };
    }

    const [updated] = await db.update(proxyApiKey).set({
      modelAccessMode: mode,
      modelAccessList: normalizedModels,
    }).where(eq(proxyApiKey.id, id)).returning({
      modelAccessMode: proxyApiKey.modelAccessMode,
      modelAccessList: proxyApiKey.modelAccessList,
    });

    await invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);

    revalidatePath("/dashboard/api-keys");
    revalidatePath("/dashboard");

    return {
      success: true,
      data: {
        mode: isApiKeyModelAccessMode(updated.modelAccessMode)
          ? updated.modelAccessMode
          : "all",
        models: updated.modelAccessList,
      },
    };
  } catch (error) {
    console.error("Failed to update API key model access:", error);
    return { success: false, error: "Failed to update API key model access" };
  }
}

/**
 * Update per-key provider account access mode and account list
 */
export async function updateApiKeyAccountAccess(
  id: string,
  mode: ApiKeyAccountAccessMode,
  accounts: string[]
): Promise<ActionResult<{ mode: ApiKeyAccountAccessMode; accounts: string[] }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  if (!isApiKeyAccountAccessMode(mode)) {
    return { success: false, error: "Invalid account access mode" };
  }

  try {
    const [apiKey] = await db.select({ id: proxyApiKey.id, keyHash: proxyApiKey.keyHash }).from(proxyApiKey).where(and(eq(proxyApiKey.id, id), eq(proxyApiKey.userId, session.user.id))).limit(1);

    if (!apiKey) {
      return { success: false, error: "API key not found" };
    }

    const normalizedAccounts = mode === "all"
      ? []
      : Array.from(new Set(accounts.map((a) => a.trim()).filter((a) => a.length > 0))).sort((a, b) => a.localeCompare(b));

    if (mode !== "all" && normalizedAccounts.length === 0) {
      return { success: false, error: "Select at least one account" };
    }

    // Validate that all account IDs belong to the current user
    if (normalizedAccounts.length > 0) {
      const validAccounts = await db
        .select({ id: providerAccount.id })
        .from(providerAccount)
        .where(
          and(
            eq(providerAccount.userId, session.user.id),
            inArray(providerAccount.id, normalizedAccounts)
          )
        );

      const validIds = new Set(validAccounts.map((a) => a.id));
      const invalidIds = normalizedAccounts.filter((id) => !validIds.has(id));

      if (invalidIds.length > 0) {
        return {
          success: false,
          error: `Unknown account: ${invalidIds[0]}`,
        };
      }
    }

    const [updated] = await db.update(proxyApiKey).set({
      accountAccessMode: mode,
      accountAccessList: normalizedAccounts,
    }).where(eq(proxyApiKey.id, id)).returning({
      accountAccessMode: proxyApiKey.accountAccessMode,
      accountAccessList: proxyApiKey.accountAccessList,
    });

    await invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);

    revalidatePath("/dashboard/api-keys");
    revalidatePath("/dashboard");

    return {
      success: true,
      data: {
        mode: isApiKeyAccountAccessMode(updated.accountAccessMode)
          ? updated.accountAccessMode
          : "all",
        accounts: updated.accountAccessList,
      },
    };
  } catch (error) {
    console.error("Failed to update API key account access:", error);
    return { success: false, error: "Failed to update API key account access" };
  }
}

/**
 * Reveal the full API key
 */
export async function revealApiKey(id: string): Promise<ActionResult<{ key: string }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const [apiKey] = await db.select({
      id: proxyApiKey.id,
      encryptedKey: proxyApiKey.encryptedKey,
      isActive: proxyApiKey.isActive,
    }).from(proxyApiKey).where(and(eq(proxyApiKey.id, id), eq(proxyApiKey.userId, session.user.id))).limit(1);

    if (!apiKey) {
      return { success: false, error: "API key not found" };
    }

    // Check if encryptedKey exists (old keys might not have it)
    if (!apiKey.encryptedKey) {
      return { 
        success: false, 
        error: "This API key was created before the reveal feature. Please generate a new key." 
      };
    }

    const key = decrypt(apiKey.encryptedKey);

    return { success: true, data: { key } };
  } catch (error) {
    console.error("Failed to reveal API key:", error);
    return { success: false, error: "Failed to reveal API key" };
  }
}

/**
 * Update API key expiration date
 */
export async function updateApiKeyExpiration(
  id: string,
  expiresAt: Date | null
): Promise<ActionResult<{ expiresAt: Date | null }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  // If a date is provided, it must be in the future
  if (expiresAt && expiresAt <= new Date()) {
    return { success: false, error: "Expiration date must be in the future" };
  }

  try {
    const [apiKey] = await db
      .select({ id: proxyApiKey.id, keyHash: proxyApiKey.keyHash })
      .from(proxyApiKey)
      .where(and(eq(proxyApiKey.id, id), eq(proxyApiKey.userId, session.user.id)))
      .limit(1);

    if (!apiKey) {
      return { success: false, error: "API key not found" };
    }

    const [updated] = await db
      .update(proxyApiKey)
      .set({ expiresAt: expiresAt ?? null })
      .where(eq(proxyApiKey.id, id))
      .returning({ expiresAt: proxyApiKey.expiresAt });

    await invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);

    revalidatePath("/dashboard/api-keys");

    return { success: true, data: { expiresAt: updated.expiresAt } };
  } catch (error) {
    console.error("Failed to update API key expiration:", error);
    return { success: false, error: "Failed to update API key expiration" };
  }
}

/**
 * Rate limit rule input type
 */
export interface RateLimitRuleInput {
  target: string;
  targetType: "model" | "family";
  perMinute: number | null;
  perHour: number | null;
  perDay: number | null;
}

/**
 * Update per-key rate limit rules (replaces all existing rules)
 */
export async function updateApiKeyRateLimits(
  id: string,
  rules: RateLimitRuleInput[]
): Promise<ActionResult<{ rules: RateLimitRuleInput[] }>> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const [apiKey] = await db
      .select({ id: proxyApiKey.id, keyHash: proxyApiKey.keyHash })
      .from(proxyApiKey)
      .where(and(eq(proxyApiKey.id, id), eq(proxyApiKey.userId, session.user.id)))
      .limit(1);

    if (!apiKey) {
      return { success: false, error: "API key not found" };
    }

    // Validate rules
    const validFamilies = new Set(getAllFamilies());
    const seenTargets = new Set<string>();

    for (const rule of rules) {
      const key = `${rule.targetType}:${rule.target}`;
      if (seenTargets.has(key)) {
        return { success: false, error: `Duplicate rate limit rule for ${rule.target}` };
      }
      seenTargets.add(key);

      if (rule.targetType === "model") {
        const resolved = resolveModelAlias(rule.target.trim());
        if (!isModelSupported(resolved)) {
          return { success: false, error: `Unknown model: ${rule.target}` };
        }
      } else if (rule.targetType === "family") {
        if (!validFamilies.has(rule.target)) {
          return { success: false, error: `Unknown model family: ${rule.target}` };
        }
      } else {
        return { success: false, error: `Invalid target type: ${rule.targetType}` };
      }

      // At least one limit must be set
      if (rule.perMinute == null && rule.perHour == null && rule.perDay == null) {
        return { success: false, error: `At least one rate limit must be set for ${rule.target}` };
      }

      // Limits must be positive
      if ((rule.perMinute != null && rule.perMinute <= 0) ||
          (rule.perHour != null && rule.perHour <= 0) ||
          (rule.perDay != null && rule.perDay <= 0)) {
        return { success: false, error: `Rate limits must be positive numbers` };
      }
    }

    // Normalize model targets
    const normalizedRules = rules.map((rule) => ({
      ...rule,
      target: rule.targetType === "model" ? resolveModelAlias(rule.target.trim()) : rule.target,
    }));

    // Replace all existing rules: delete then insert
    await db.delete(proxyApiKeyRateLimit).where(eq(proxyApiKeyRateLimit.apiKeyId, apiKey.id));

    if (normalizedRules.length > 0) {
      await db.insert(proxyApiKeyRateLimit).values(
        normalizedRules.map((rule) => ({
          apiKeyId: apiKey.id,
          target: rule.target,
          targetType: rule.targetType,
          perMinute: rule.perMinute,
          perHour: rule.perHour,
          perDay: rule.perDay,
        }))
      );
    }

    await invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);

    revalidatePath("/dashboard/api-keys");

    return { success: true, data: { rules: normalizedRules } };
  } catch (error) {
    console.error("Failed to update API key rate limits:", error);
    return { success: false, error: "Failed to update API key rate limits" };
  }
}
