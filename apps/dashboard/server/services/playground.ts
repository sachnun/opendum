import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";

import { db } from "../lib/db";
import { disabledModel, providerAccount, providerAccountDisabledModel, proxyApiKey } from "../lib/db/schema";
import { decrypt } from "../lib/encryption";
import { getAccountModelAvailability, isModelUsableByAccounts } from "../lib/proxy/auth";
import { getAllModels, getModelFamily, getProvidersForModel, resolveModelAlias } from "../lib/proxy/models";

type ApiKeyModelAccessMode = "all" | "whitelist" | "blacklist";

function normalizeProxyBaseUrl(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\/$/, "") || undefined : undefined;
}

function getProxyBaseUrl(proxyBaseUrl?: string) {
  return normalizeProxyBaseUrl(proxyBaseUrl) ?? normalizeProxyBaseUrl(process.env.NUXT_PUBLIC_PROXY_URL);
}

function normalizeApiKeyModelAccessMode(mode: string): ApiKeyModelAccessMode {
  return mode === "whitelist" || mode === "blacklist" ? mode : "all";
}

function toPlaygroundApiKeyOption(apiKey: { id: string; name: string | null; keyPreview: string; encryptedKey: string | null; modelAccessMode: string; modelAccessList: string[] | null }) {
  if (!apiKey.encryptedKey) return null;

  try {
    return {
      id: apiKey.id,
      name: apiKey.name,
      keyPreview: apiKey.keyPreview,
      decryptedKey: decrypt(apiKey.encryptedKey),
      modelAccessMode: normalizeApiKeyModelAccessMode(apiKey.modelAccessMode),
      modelAccessList: apiKey.modelAccessList ?? [],
    };
  } catch {
    return null;
  }
}

export async function getPlaygroundOptions(userId: string, proxyUrl?: string) {
  try {
    const proxyBaseUrl = getProxyBaseUrl(proxyUrl);
    const [disabledModels, availability] = await Promise.all([
      db.select({ model: disabledModel.model }).from(disabledModel).where(eq(disabledModel.userId, userId)),
      getAccountModelAvailability(userId),
    ]);
    const disabledModelSet = new Set(disabledModels.map((entry) => resolveModelAlias(entry.model)));

    const providerAccounts = await db
      .select({
        id: providerAccount.id,
        provider: providerAccount.provider,
        name: providerAccount.name,
        email: providerAccount.email,
      })
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.isActive, true), or(isNull(providerAccount.disabledUntil), lte(providerAccount.disabledUntil, new Date()))))
      .orderBy(asc(providerAccount.provider), asc(providerAccount.createdAt));

    const disabledModelsByAccount = new Map<string, string[]>();
    if (providerAccounts.length > 0) {
      const perAccountDisabledModels = await db
        .select({ providerAccountId: providerAccountDisabledModel.providerAccountId, model: providerAccountDisabledModel.model })
        .from(providerAccountDisabledModel)
        .where(inArray(providerAccountDisabledModel.providerAccountId, providerAccounts.map((account) => account.id)));

      for (const entry of perAccountDisabledModels) {
        const canonical = resolveModelAlias(entry.model);
        const current = disabledModelsByAccount.get(entry.providerAccountId) ?? [];
        current.push(canonical);
        disabledModelsByAccount.set(entry.providerAccountId, current);
      }
    }

    const models = getAllModels()
      .filter((model) => !disabledModelSet.has(model) && isModelUsableByAccounts(model, availability))
      .map((model) => ({
        id: model,
        name: model,
        family: getModelFamily(model),
        providers: getProvidersForModel(model).filter((provider) => availability.activeProviders.has(provider)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const apiKeyOptions = proxyBaseUrl
      ? (await db
          .select({
            id: proxyApiKey.id,
            name: proxyApiKey.name,
            keyPreview: proxyApiKey.keyPreview,
            encryptedKey: proxyApiKey.encryptedKey,
            modelAccessMode: proxyApiKey.modelAccessMode,
            modelAccessList: proxyApiKey.modelAccessList,
          })
          .from(proxyApiKey)
          .where(and(eq(proxyApiKey.userId, userId), eq(proxyApiKey.isActive, true)))
          .orderBy(desc(proxyApiKey.lastUsedAt)))
          .flatMap((apiKey) => toPlaygroundApiKeyOption(apiKey) ?? [])
      : [];

    return {
      proxyBaseUrl,
      models,
      providerAccounts: providerAccounts.map((account) => ({
        ...account,
        disabledModels: disabledModelsByAccount.get(account.id) ?? [],
      })),
      apiKeyOptions,
    };
  } catch (error) {
    console.error("Failed to load playground options:", error);
    throw new Error("Failed to load playground options");
  }
}
