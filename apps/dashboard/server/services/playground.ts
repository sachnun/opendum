import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../lib/db";
import { disabledModel, providerAccount, providerAccountDisabledModel } from "../lib/db/schema";
import { getAccountModelAvailability, isModelUsableByAccounts } from "../lib/proxy/auth";
import { getAuthlessProviderAccounts } from "../lib/proxy/authless-providers";
import { MODEL_REGISTRY, getAllModels, getModelFamily, getProvidersForModel, resolveModelAlias } from "../lib/proxy/models";
import { createServiceTimer } from "../utils/timing";
import { compareModelEntries } from "../../lib/model-sort";
import { PROVIDER_ACCOUNT_KEYS } from "./account-providers";

function normalizeProxyBaseUrl(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\/$/, "") || undefined : undefined;
}

function getProxyBaseUrl(proxyBaseUrl?: string) {
  return normalizeProxyBaseUrl(proxyBaseUrl) ?? normalizeProxyBaseUrl(process.env.NUXT_PUBLIC_PROXY_URL);
}

export async function getPlaygroundOptions(userId: string, proxyUrl?: string) {
  const timer = createServiceTimer("playground.options");
  try {
    const proxyBaseUrl = getProxyBaseUrl(proxyUrl);
    const [disabledModels, availability] = await Promise.all([
      timer.time("disabledModels", () => db.select({ model: disabledModel.model }).from(disabledModel).where(eq(disabledModel.userId, userId))),
      timer.time("availability", () => getAccountModelAvailability(userId, { includeInactiveAccounts: true })),
    ]);
    const disabledModelSet = new Set(disabledModels.map((entry) => resolveModelAlias(entry.model)));

    const authlessProviderAccounts = getAuthlessProviderAccounts();
    const [accountCount] = await timer.time("accountCount", () => db
      .select({ count: sql<number>`count(*)` })
      .from(providerAccount)
      .where(eq(providerAccount.userId, userId)));

    const providerAccounts = await timer.time("providerAccounts", () => db
      .select({
        id: providerAccount.id,
        provider: providerAccount.provider,
        name: providerAccount.name,
        email: providerAccount.email,
        isActive: providerAccount.isActive,
        disabledUntil: providerAccount.disabledUntil,
      })
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), inArray(providerAccount.provider, PROVIDER_ACCOUNT_KEYS)))
      .orderBy(asc(providerAccount.provider), asc(providerAccount.createdAt)));

    const disabledModelsByAccount = new Map<string, string[]>();
    if (providerAccounts.length > 0) {
      const perAccountDisabledModels = await timer.time("perAccountDisabledModels", () => db
        .select({ providerAccountId: providerAccountDisabledModel.providerAccountId, model: providerAccountDisabledModel.model })
        .from(providerAccountDisabledModel)
        .where(inArray(providerAccountDisabledModel.providerAccountId, providerAccounts.map((account) => account.id))));

      for (const entry of perAccountDisabledModels) {
        const canonical = resolveModelAlias(entry.model);
        const current = disabledModelsByAccount.get(entry.providerAccountId) ?? [];
        current.push(canonical);
        disabledModelsByAccount.set(entry.providerAccountId, current);
      }
    }

    const modelsStartedAt = Date.now();
    const models = getAllModels()
      .filter((model) => !disabledModelSet.has(model) && isModelUsableByAccounts(model, availability))
      .map((model) => ({
        id: model,
        name: model,
        family: getModelFamily(model),
        providers: getProvidersForModel(model).filter((provider) => availability.activeProviders.has(provider)),
        meta: MODEL_REGISTRY[model]?.meta,
      }))
      .sort(compareModelEntries);
    timer.record("models", modelsStartedAt);
    timer.log({ providerAccounts: providerAccounts.length, authlessProviderAccounts: authlessProviderAccounts.length, models: models.length });

    return {
      proxyBaseUrl,
      hasAnyProviderAccount: Number(accountCount?.count ?? 0) > 0 || authlessProviderAccounts.length > 0,
      models,
      providerAccounts: [
        ...authlessProviderAccounts,
        ...providerAccounts.map((account) => ({
        ...account,
        disabledModels: disabledModelsByAccount.get(account.id) ?? [],
        supportedModels: null,
        })),
      ],
    };
  } catch (error) {
    console.error("Failed to load playground options:", error);
    throw new Error("Failed to load playground options");
  }
}
