import { db } from "@opendum/shared/db";
import { providerAccount, proxyApiKey, proxyApiKeyRateLimit } from "@opendum/shared/db/schema";
import { decrypt, encrypt, generateApiKey, getKeyPreview, hashString } from "@opendum/shared/encryption";
import { invalidateApiKeyValidationCache } from "@opendum/shared/proxy/auth";
import { getAllFamilies, isModelSupported, resolveModelAlias } from "@opendum/shared/proxy/models";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure, router } from "../init";

const apiKeyModelAccessModeSchema = z.enum(["all", "whitelist", "blacklist"]);
const apiKeyAccountAccessModeSchema = z.enum(["all", "whitelist", "blacklist"]);
const rateLimitRuleSchema = z.object({
  target: z.string(),
  targetType: z.enum(["model", "family"]),
  perMinute: z.number().int().nullable(),
  perHour: z.number().int().nullable(),
  perDay: z.number().int().nullable(),
});

function normalizeModelList(models: string[]): string[] {
  return Array.from(new Set(models.map((model) => resolveModelAlias(model.trim())).filter((model) => model.length > 0))).sort((a, b) => a.localeCompare(b));
}

async function getOwnedApiKey(userId: string, id: string) {
  const [apiKey] = await db.select().from(proxyApiKey).where(and(eq(proxyApiKey.id, id), eq(proxyApiKey.userId, userId))).limit(1);
  return apiKey ?? null;
}

export const apiKeysRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
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
        .where(eq(proxyApiKey.userId, ctx.userId))
        .orderBy(desc(proxyApiKey.createdAt));
    } catch (error) {
      console.error("Failed to list API keys:", error);
      throw new Error("Failed to list API keys");
    }
  }),

  create: protectedProcedure
    .input(z.object({ name: z.string().optional(), expiresAt: z.coerce.date().nullable().optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      try {
        const key = generateApiKey();
        const [apiKey] = await db.insert(proxyApiKey).values({ userId: ctx.userId, keyHash: hashString(key), keyPreview: getKeyPreview(key), encryptedKey: encrypt(key), name: input?.name?.trim() || null, expiresAt: input?.expiresAt ?? null }).returning();
        if (!apiKey) return { success: false, error: "Failed to create API key" } as const;
        return { success: true, data: { id: apiKey.id, key, keyPreview: apiKey.keyPreview, name: apiKey.name, expiresAt: apiKey.expiresAt } } as const;
      } catch (error) {
        console.error("Failed to create API key:", error);
        return { success: false, error: "Failed to create API key" } as const;
      }
    }),

  toggle: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    try {
      const apiKey = await getOwnedApiKey(ctx.userId, input.id);
      if (!apiKey) return { success: false, error: "API key not found" } as const;
      await db.update(proxyApiKey).set({ isActive: !apiKey.isActive }).where(eq(proxyApiKey.id, input.id));
      await invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
      return { success: true, data: undefined } as const;
    } catch (error) {
      console.error("Failed to toggle API key:", error);
      return { success: false, error: "Failed to toggle API key" } as const;
    }
  }),

  delete: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    try {
      const apiKey = await getOwnedApiKey(ctx.userId, input.id);
      if (!apiKey) return { success: false, error: "API key not found" } as const;
      await db.delete(proxyApiKey).where(eq(proxyApiKey.id, input.id));
      await invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
      return { success: true, data: undefined } as const;
    } catch (error) {
      console.error("Failed to delete API key:", error);
      return { success: false, error: "Failed to delete API key" } as const;
    }
  }),

  reveal: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    try {
      const apiKey = await getOwnedApiKey(ctx.userId, input.id);
      if (!apiKey) return { success: false, error: "API key not found" } as const;
      if (!apiKey.encryptedKey) return { success: false, error: "This API key was created before the reveal feature. Please generate a new key." } as const;
      return { success: true, data: { key: decrypt(apiKey.encryptedKey) } } as const;
    } catch (error) {
      console.error("Failed to reveal API key:", error);
      return { success: false, error: "Failed to reveal API key" } as const;
    }
  }),

  updateName: protectedProcedure.input(z.object({ id: z.string(), name: z.string() })).mutation(async ({ ctx, input }) => {
    try {
      const apiKey = await getOwnedApiKey(ctx.userId, input.id);
      if (!apiKey) return { success: false, error: "API key not found" } as const;
      const [updated] = await db.update(proxyApiKey).set({ name: input.name.trim() || null }).where(eq(proxyApiKey.id, input.id)).returning({ name: proxyApiKey.name });
      if (!updated) return { success: false, error: "Failed to update API key name" } as const;
      return { success: true, data: { name: updated.name } } as const;
    } catch (error) {
      console.error("Failed to update API key name:", error);
      return { success: false, error: "Failed to update API key name" } as const;
    }
  }),

  updateExpiration: protectedProcedure.input(z.object({ id: z.string(), expiresAt: z.coerce.date().nullable() })).mutation(async ({ ctx, input }) => {
    if (input.expiresAt && input.expiresAt <= new Date()) return { success: false, error: "Expiration date must be in the future" } as const;
    try {
      const apiKey = await getOwnedApiKey(ctx.userId, input.id);
      if (!apiKey) return { success: false, error: "API key not found" } as const;
      const [updated] = await db.update(proxyApiKey).set({ expiresAt: input.expiresAt }).where(eq(proxyApiKey.id, input.id)).returning({ expiresAt: proxyApiKey.expiresAt });
      if (!updated) return { success: false, error: "Failed to update API key expiration" } as const;
      await invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
      return { success: true, data: { expiresAt: updated.expiresAt } } as const;
    } catch (error) {
      console.error("Failed to update API key expiration:", error);
      return { success: false, error: "Failed to update API key expiration" } as const;
    }
  }),

  updateModelAccess: protectedProcedure.input(z.object({ id: z.string(), mode: apiKeyModelAccessModeSchema, models: z.array(z.string()) })).mutation(async ({ ctx, input }) => {
    try {
      const apiKey = await getOwnedApiKey(ctx.userId, input.id);
      if (!apiKey) return { success: false, error: "API key not found" } as const;
      const normalizedModels = input.mode === "all" ? [] : normalizeModelList(input.models);
      if (input.mode !== "all" && normalizedModels.length === 0) return { success: false, error: "Select at least one model" } as const;
      const invalidModel = normalizedModels.find((model) => !isModelSupported(model));
      if (invalidModel) return { success: false, error: `Unknown model: ${invalidModel}` } as const;
      const [updated] = await db.update(proxyApiKey).set({ modelAccessMode: input.mode, modelAccessList: normalizedModels }).where(eq(proxyApiKey.id, input.id)).returning({ modelAccessMode: proxyApiKey.modelAccessMode, modelAccessList: proxyApiKey.modelAccessList });
      if (!updated) return { success: false, error: "Failed to update API key model access" } as const;
      await invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
      return { success: true, data: { mode: apiKeyModelAccessModeSchema.safeParse(updated.modelAccessMode).success ? updated.modelAccessMode as z.infer<typeof apiKeyModelAccessModeSchema> : "all", models: updated.modelAccessList } } as const;
    } catch (error) {
      console.error("Failed to update API key model access:", error);
      return { success: false, error: "Failed to update API key model access" } as const;
    }
  }),

  updateAccountAccess: protectedProcedure.input(z.object({ id: z.string(), mode: apiKeyAccountAccessModeSchema, accounts: z.array(z.string()) })).mutation(async ({ ctx, input }) => {
    try {
      const apiKey = await getOwnedApiKey(ctx.userId, input.id);
      if (!apiKey) return { success: false, error: "API key not found" } as const;
      const normalizedAccounts = input.mode === "all" ? [] : Array.from(new Set(input.accounts.map((account) => account.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
      if (input.mode !== "all" && normalizedAccounts.length === 0) return { success: false, error: "Select at least one account" } as const;
      if (normalizedAccounts.length > 0) {
        const rows = await db.select({ id: providerAccount.id }).from(providerAccount).where(and(eq(providerAccount.userId, ctx.userId), inArray(providerAccount.id, normalizedAccounts)));
        const validIds = new Set(rows.map((row) => row.id));
        const invalidId = normalizedAccounts.find((id) => !validIds.has(id));
        if (invalidId) return { success: false, error: `Unknown account: ${invalidId}` } as const;
      }
      const [updated] = await db.update(proxyApiKey).set({ accountAccessMode: input.mode, accountAccessList: normalizedAccounts }).where(eq(proxyApiKey.id, input.id)).returning({ accountAccessMode: proxyApiKey.accountAccessMode, accountAccessList: proxyApiKey.accountAccessList });
      if (!updated) return { success: false, error: "Failed to update API key account access" } as const;
      await invalidateApiKeyValidationCache(apiKey.keyHash, apiKey.id);
      return { success: true, data: { mode: apiKeyAccountAccessModeSchema.safeParse(updated.accountAccessMode).success ? updated.accountAccessMode as z.infer<typeof apiKeyAccountAccessModeSchema> : "all", accounts: updated.accountAccessList } } as const;
    } catch (error) {
      console.error("Failed to update API key account access:", error);
      return { success: false, error: "Failed to update API key account access" } as const;
    }
  }),

  updateRateLimits: protectedProcedure.input(z.object({ id: z.string(), rules: z.array(rateLimitRuleSchema) })).mutation(async ({ ctx, input }) => {
    try {
      const apiKey = await getOwnedApiKey(ctx.userId, input.id);
      if (!apiKey) return { success: false, error: "API key not found" } as const;
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
    } catch (error) {
      console.error("Failed to update API key rate limits:", error);
      return { success: false, error: "Failed to update API key rate limits" } as const;
    }
  }),
});
