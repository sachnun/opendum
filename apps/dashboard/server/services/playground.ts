import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { db } from "../lib/db";
import { disabledModel, providerAccount, providerAccountDisabledModel } from "../lib/db/schema";
import { getAccountModelAvailability, isModelUsableByAccounts } from "../lib/proxy/auth";
import { getAuthlessProviderAccounts } from "../lib/proxy/authless-providers";
import { getAllModels, getModelFamily, getProvidersForModel, resolveModelAlias } from "../lib/proxy/models";

function normalizeProxyBaseUrl(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\/$/, "") || undefined : undefined;
}

function getProxyBaseUrl(proxyBaseUrl?: string) {
  return normalizeProxyBaseUrl(proxyBaseUrl) ?? normalizeProxyBaseUrl(process.env.NUXT_PUBLIC_PROXY_URL);
}

export async function getPlaygroundOptions(userId: string, proxyUrl?: string) {
  try {
    const proxyBaseUrl = getProxyBaseUrl(proxyUrl);
    const [disabledModels, availability] = await Promise.all([
      db.select({ model: disabledModel.model }).from(disabledModel).where(eq(disabledModel.userId, userId)),
      getAccountModelAvailability(userId),
    ]);
    const disabledModelSet = new Set(disabledModels.map((entry) => resolveModelAlias(entry.model)));

    const authlessProviderAccounts = getAuthlessProviderAccounts();
    const [accountCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(providerAccount)
      .where(eq(providerAccount.userId, userId));

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

    return {
      proxyBaseUrl,
      hasAnyProviderAccount: Number(accountCount?.count ?? 0) > 0 || authlessProviderAccounts.length > 0,
      models,
      providerAccounts: [
        ...authlessProviderAccounts,
        ...providerAccounts.map((account) => ({
        ...account,
        disabledModels: disabledModelsByAccount.get(account.id) ?? [],
        })),
      ],
    };
  } catch (error) {
    console.error("Failed to load playground options:", error);
    throw new Error("Failed to load playground options");
  }
}
