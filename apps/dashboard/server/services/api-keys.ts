import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { providerAccount, proxyApiKey, proxyApiKeyRateLimit } from "../lib/db/schema";
import { decrypt, encrypt, generateApiKey, getKeyPreview, hashString } from "../lib/encryption";
import { invalidateApiKeyValidationCache } from "../lib/proxy/auth";
import { getAuthlessProviderAccounts, isSyntheticAuthlessAccount } from "../lib/proxy/authless-providers";
import { getAllFamilies, getAllModels, isModelSupported, resolveModelAlias } from "../lib/proxy/models";
import type { ActionResult } from "../utils/api";
import { PROVIDER_ACCOUNT_KEYS } from "./account-providers";

export const apiKeyIdInputSchema = z.object({ id: z.string() });
export const createApiKeyInputSchema = z.object({ name: z.string().optional(), expiresAt: z.coerce.date().nullable().optional() }).optional();
export const updateApiKeyNameInputSchema = z.object({ id: z.string(), name: z.string() });
export const updateApiKeyExpirationInputSchema = z.object({ id: z.string(), expiresAt: z.coerce.date().nullable() });

const apiKeyModelAccessModeSchema = z.enum(["all", "whitelist", "blacklist"]);
const apiKeyAccountAccessModeSchema = z.enum(["all", "whitelist", "blacklist"]);
const rateLimitRuleSchema = z.object({
  target: z.string(),
  targetType: z.enum(["model", "family"]),
  perMinute: z.number().int().nullable(),
  perHour: z.number().int().nullable(),
  perDay: z.number().int().nullable(),
});
export const updateApiKeyModelAccessInputSchema = z.object({ id: z.string(), mode: apiKeyModelAccessModeSchema, models: z.array(z.string()) });
export const updateApiKeyAccountAccessInputSchema = z.object({ id: z.string(), mode: apiKeyAccountAccessModeSchema, accounts: z.array(z.string()) });
export const updateApiKeyRateLimitsInputSchema = z.object({ id: z.string(), rules: z.array(rateLimitRuleSchema) });

type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>;
type UpdateApiKeyNameInput = z.infer<typeof updateApiKeyNameInputSchema>;
type UpdateApiKeyExpirationInput = z.infer<typeof updateApiKeyExpirationInputSchema>;
type UpdateApiKeyModelAccessInput = z.infer<typeof updateApiKeyModelAccessInputSchema>;
type UpdateApiKeyAccountAccessInput = z.infer<typeof updateApiKeyAccountAccessInputSchema>;
type UpdateApiKeyRateLimitsInput = z.infer<typeof updateApiKeyRateLimitsInputSchema>;

function normalizeModelList(models: string[]): string[] {
  return Array.from(new Set(models.map((model) => resolveModelAlias(model.trim())).filter((model) => model.length > 0))).sort((a, b) => a.localeCompare(b));
}

async function getOwnedApiKey(userId: string, id: string) {
  const [apiKey] = await db.select().from(proxyApiKey).where(and(eq(proxyApiKey.id, id), eq(proxyApiKey.userId, userId))).limit(1);
  return apiKey ?? null;
}

type OwnedApiKey = NonNullable<Awaited<ReturnType<typeof getOwnedApiKey>>>;

async function withOwnedApiKey<T>(userId: string, id: string, failureMessage: string, action: (apiKey: OwnedApiKey) => Promise<ActionResult<T>> | ActionResult<T>): Promise<ActionResult<T>> {
  try {
    const apiKey = await getOwnedApiKey(userId, id);
    if (!apiKey) return { success: false, error: "API key not found" };
    return await action(apiKey);
  } catch (error) {
    console.error(`${failureMessage}:`, error);
    return { success: false, error: failureMessage };
  }
}

export async function getApiKeyOptions(userId: string) {
  try {
    const apiKeys = await db.select({ id: proxyApiKey.id }).from(proxyApiKey).where(eq(proxyApiKey.userId, userId));
    const apiKeyIds = apiKeys.map((key) => key.id);
    const rateLimitRows = apiKeyIds.length > 0
      ? await db
          .select({ apiKeyId: proxyApiKeyRateLimit.apiKeyId, target: proxyApiKeyRateLimit.target, targetType: proxyApiKeyRateLimit.targetType, perMinute: proxyApiKeyRateLimit.perMinute, perHour: proxyApiKeyRateLimit.perHour, perDay: proxyApiKeyRateLimit.perDay })
          .from(proxyApiKeyRateLimit)
          .where(inArray(proxyApiKeyRateLimit.apiKeyId, apiKeyIds))
      : [];
    const providerAccounts = await db
      .select({ id: providerAccount.id, provider: providerAccount.provider, name: providerAccount.name, email: providerAccount.email })
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), inArray(providerAccount.provider, PROVIDER_ACCOUNT_KEYS)))
      .orderBy(asc(providerAccount.provider), asc(providerAccount.name));

    return {
      availableModels: getAllModels().sort((a, b) => a.localeCompare(b)),
      availableFamilies: getAllFamilies(),
      providerAccounts: [
        ...getAuthlessProviderAccounts().map(({ disabledModels: _disabledModels, ...account }) => account),
        ...providerAccounts,
      ],
      rateLimitsByKeyId: rateLimitRows.reduce<Record<string, Array<{ target: string; targetType: "model" | "family"; perMinute: number | null; perHour: number | null; perDay: number | null }>>>((acc, row) => {
        acc[row.apiKeyId] = [
          ...(acc[row.apiKeyId] ?? []),
          { target: row.target, targetType: row.targetType === "family" ? "family" : "model", perMinute: row.perMinute, perHour: row.perHour, perDay: row.perDay },
        ];
        return acc;
      }, {}),
    };
  } catch (error) {
    console.error("Failed to load API key options:", error);
    throw new Error("Failed to load API key options");
  }
}

export async function listApiKeys(userId: string) {
  try {
    return await db
      .select({
        id: proxyApiKey.id,
        name: proxyApiKey.name,
        keyPreview: proxyApiKey.keyPreview,
        isActive: proxyApiKey.isActive,
        createdAt: proxyApiKey.createdAt,
        expiresAt: proxyApiKey.expiresAt,
        lastUsedAt: proxyApiKey.lastUsedAt,
        modelAccessMode: proxyApiKey.modelAccessMode,
        modelAccessList: proxyApiKey.modelAccessList,
        accountAccessMode: proxyApiKey.accountAccessMode,
        accountAccessList: proxyApiKey.accountAccessList,
      })
      .from(proxyApiKey)
      .where(eq(proxyApiKey.userId, userId))
      .orderBy(desc(proxyApiKey.createdAt));
  } catch (error) {
    console.error("Failed to list API keys:", error);
    throw new Error("Failed to list API keys");
  }
}

export async function createApiKey(userId: string, input: CreateApiKeyInput) {
  try {
    const key = generateApiKey();
    const [apiKey] = await db.insert(proxyApiKey).values({ userId, keyHash: hashString(key), keyPreview: getKeyPreview(key), encryptedKey: encrypt(key), name: input?.name?.trim() || null, expiresAt: input?.expiresAt ?? null }).returning();
    if (!apiKey) return { success: false, error: "Failed to create API key" } as const;
    return { success: true, data: { id: apiKey.id, key, keyPreview: apiKey.keyPreview, name: apiKey.name, expiresAt: apiKey.expiresAt } } as const;
  } catch (error) {
    console.error("Failed to create API key:", error);
    return { success: false, error: "Failed to create API key" } as const;
  }
}

export async function toggleApiKey(userId: string, id: string) {
  return withOwnedApiKey(userId, id, "Failed to toggle API key", async (apiKey) => {
    const isActive = !apiKey.isActive;
    await db.update(proxyApiKey).set({ isActive }).where(eq(proxyApiKey.id, id));
    await invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
    return { success: true, data: { id, isActive } } as const;
  });
}

export async function deleteApiKey(userId: string, id: string) {
  return withOwnedApiKey(userId, id, "Failed to delete API key", async (apiKey) => {
    await db.delete(proxyApiKey).where(eq(proxyApiKey.id, id));
    await invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
    return { success: true, data: undefined };
  });
}

export async function revealApiKey(userId: string, id: string) {
  return withOwnedApiKey(userId, id, "Failed to reveal API key", (apiKey) => {
    if (!apiKey.encryptedKey) return { success: false, error: "This API key was created before the reveal feature. Please generate a new key." } as const;
    return { success: true, data: { key: decrypt(apiKey.encryptedKey) } } as const;
  });
}

export async function updateApiKeyName(userId: string, input: UpdateApiKeyNameInput) {
  return withOwnedApiKey(userId, input.id, "Failed to update API key name", async () => {
    const [updated] = await db.update(proxyApiKey).set({ name: input.name.trim() || null }).where(eq(proxyApiKey.id, input.id)).returning({ name: proxyApiKey.name });
    if (!updated) return { success: false, error: "Failed to update API key name" } as const;
    return { success: true, data: { name: updated.name } } as const;
  });
}

export async function updateApiKeyExpiration(userId: string, input: UpdateApiKeyExpirationInput) {
  if (input.expiresAt && input.expiresAt <= new Date()) return { success: false, error: "Expiration date must be in the future" } as const;
  return withOwnedApiKey(userId, input.id, "Failed to update API key expiration", async (apiKey) => {
    const [updated] = await db.update(proxyApiKey).set({ expiresAt: input.expiresAt }).where(eq(proxyApiKey.id, input.id)).returning({ expiresAt: proxyApiKey.expiresAt });
    if (!updated) return { success: false, error: "Failed to update API key expiration" } as const;
    await invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
    return { success: true, data: { expiresAt: updated.expiresAt } } as const;
  });
}

export async function updateApiKeyModelAccess(userId: string, input: UpdateApiKeyModelAccessInput) {
  return withOwnedApiKey(userId, input.id, "Failed to update API key model access", async (apiKey) => {
    const normalizedModels = input.mode === "all" ? [] : normalizeModelList(input.models);
    if (input.mode !== "all" && normalizedModels.length === 0) return { success: false, error: "Select at least one model" } as const;
    const invalidModel = normalizedModels.find((model) => !isModelSupported(model));
    if (invalidModel) return { success: false, error: `Unknown model: ${invalidModel}` } as const;
    const [updated] = await db.update(proxyApiKey).set({ modelAccessMode: input.mode, modelAccessList: normalizedModels }).where(eq(proxyApiKey.id, input.id)).returning({ modelAccessMode: proxyApiKey.modelAccessMode, modelAccessList: proxyApiKey.modelAccessList });
    if (!updated) return { success: false, error: "Failed to update API key model access" } as const;
    await invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
    return { success: true, data: { mode: apiKeyModelAccessModeSchema.safeParse(updated.modelAccessMode).success ? updated.modelAccessMode as z.infer<typeof apiKeyModelAccessModeSchema> : "all", models: updated.modelAccessList } } as const;
  });
}

export async function updateApiKeyAccountAccess(userId: string, input: UpdateApiKeyAccountAccessInput) {
  return withOwnedApiKey(userId, input.id, "Failed to update API key account access", async (apiKey) => {
    const normalizedAccounts = input.mode === "all" ? [] : Array.from(new Set(input.accounts.map((account) => account.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    if (input.mode !== "all" && normalizedAccounts.length === 0) return { success: false, error: "Select at least one account" } as const;
    if (normalizedAccounts.length > 0) {
      const rows = await db.select({ id: providerAccount.id }).from(providerAccount).where(and(eq(providerAccount.userId, userId), inArray(providerAccount.id, normalizedAccounts)));
      const validIds = new Set([...rows.map((row) => row.id), ...normalizedAccounts.filter(isSyntheticAuthlessAccount)]);
      const invalidId = normalizedAccounts.find((id) => !validIds.has(id));
      if (invalidId) return { success: false, error: `Unknown account: ${invalidId}` } as const;
    }
    const [updated] = await db.update(proxyApiKey).set({ accountAccessMode: input.mode, accountAccessList: normalizedAccounts }).where(eq(proxyApiKey.id, input.id)).returning({ accountAccessMode: proxyApiKey.accountAccessMode, accountAccessList: proxyApiKey.accountAccessList });
    if (!updated) return { success: false, error: "Failed to update API key account access" } as const;
    await invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
    return { success: true, data: { mode: apiKeyAccountAccessModeSchema.safeParse(updated.accountAccessMode).success ? updated.accountAccessMode as z.infer<typeof apiKeyAccountAccessModeSchema> : "all", accounts: updated.accountAccessList } } as const;
  });
}

export async function updateApiKeyRateLimits(userId: string, input: UpdateApiKeyRateLimitsInput) {
  return withOwnedApiKey(userId, input.id, "Failed to update API key rate limits", async (apiKey) => {
    const validFamilies = new Set(getAllFamilies());
    const seenTargets = new Set<string>();
    for (const rule of input.rules) {
      const key = `${rule.targetType}:${rule.target}`;
      if (seenTargets.has(key)) return { success: false, error: `Duplicate rate limit rule for ${rule.target}` } as const;
      seenTargets.add(key);
      if (rule.targetType === "model" && !isModelSupported(resolveModelAlias(rule.target.trim()))) return { success: false, error: `Unknown model: ${rule.target}` } as const;
      if (rule.targetType === "family" && !validFamilies.has(rule.target)) return { success: false, error: `Unknown model family: ${rule.target}` } as const;
      if (rule.perMinute == null && rule.perHour == null && rule.perDay == null) return { success: false, error: `At least one rate limit must be set for ${rule.target}` } as const;
      if ((rule.perMinute != null && rule.perMinute <= 0) || (rule.perHour != null && rule.perHour <= 0) || (rule.perDay != null && rule.perDay <= 0)) return { success: false, error: "Rate limits must be positive numbers" } as const;
    }
    const normalizedRules = input.rules.map((rule) => ({ ...rule, target: rule.targetType === "model" ? resolveModelAlias(rule.target.trim()) : rule.target }));
    await db.delete(proxyApiKeyRateLimit).where(eq(proxyApiKeyRateLimit.apiKeyId, apiKey.id));
    if (normalizedRules.length > 0) await db.insert(proxyApiKeyRateLimit).values(normalizedRules.map((rule) => ({ apiKeyId: apiKey.id, target: rule.target, targetType: rule.targetType, perMinute: rule.perMinute, perHour: rule.perHour, perDay: rule.perDay })));
    await invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
    return { success: true, data: { rules: normalizedRules } } as const;
  });
}
