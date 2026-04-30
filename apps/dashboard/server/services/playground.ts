import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { db } from "../lib/db";
import { disabledModel, providerAccount, providerAccountDisabledModel, proxyApiKey } from "../lib/db/schema";
import { decrypt } from "../lib/encryption";
import { getAccountModelAvailability, isModelUsableByAccounts } from "../lib/proxy/auth";
import { getAllModels, getModelFamily, getProvidersForModel, resolveModelAlias } from "../lib/proxy/models";

type ApiKeyModelAccessMode = "all" | "whitelist" | "blacklist";

function getProxyBaseUrl() {
  return (process.env.NUXT_PUBLIC_PROXY_URL || process.env.NEXT_PUBLIC_PROXY_URL || "").replace(/\/$/, "") || undefined;
}

function normalizeApiKeyModelAccessMode(mode: string): ApiKeyModelAccessMode {
  return mode === "whitelist" || mode === "blacklist" ? mode : "all";
}

export async function getPlaygroundOptions(userId: string) {
  try {
    const proxyBaseUrl = getProxyBaseUrl();
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
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.isActive, true)))
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
          .flatMap((apiKey) => {
            if (!apiKey.encryptedKey) return [];

            try {
              return [{
                id: apiKey.id,
                name: apiKey.name,
                keyPreview: apiKey.keyPreview,
                decryptedKey: decrypt(apiKey.encryptedKey),
                modelAccessMode: normalizeApiKeyModelAccessMode(apiKey.modelAccessMode),
                modelAccessList: apiKey.modelAccessList ?? [],
              }];
            } catch {
              return [];
            }
          })
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
