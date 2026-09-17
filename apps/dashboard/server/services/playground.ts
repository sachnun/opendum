import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db, disabledModel, providerAccount, providerAccountDisabledModel } from "@opendum/database";
import { getAccountModelAvailability, isModelUsableByAccounts } from "../lib/proxy/auth";
import { getAuthlessProviderAccounts } from "../lib/proxy/authless-providers";
import { MODEL_REGISTRY, getAllModels, getModelFamily, getProvidersForModel, resolveModelAlias } from "../lib/proxy/models";
import { compareModelEntries } from "../../lib/model-sort";
import { getProviderModelsForAccountTier } from "./accounts";
import { PROVIDER_ACCOUNT_KEYS } from "./account-providers";

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
      getAccountModelAvailability(userId, { includeInactiveAccounts: true }),
    ]);
    const disabledModelSet = new Set(disabledModels.map((entry) => resolveModelAlias(entry.model)));

    const authlessProviderAccounts = getAuthlessProviderAccounts();
    const customSlugs = Array.from(availability.customProviderModels.keys());
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
        tier: providerAccount.tier,
        isActive: providerAccount.isActive,
        disabledUntil: providerAccount.disabledUntil,
      })
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), inArray(providerAccount.provider, [...PROVIDER_ACCOUNT_KEYS, ...customSlugs])))
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

    const models = [
      ...getAllModels()
        .filter((model) => !disabledModelSet.has(model) && isModelUsableByAccounts(model, availability))
        .map((model) => {
          const providerConfigs = MODEL_REGISTRY[model]?.providerConfig ?? {};
          const topPDeprecatedProviders = Object.entries(providerConfigs)
            .filter(([, cfg]) => (cfg as Record<string, unknown>).top_p_deprecated === true)
            .map(([provider]) => provider);

          return {
            id: model,
            name: model,
            family: getModelFamily(model),
            providers: [...new Set([
              ...getProvidersForModel(model).filter((provider) => availability.activeProviders.has(provider)),
              ...customSlugs.filter((slug) => availability.customProviderModels.get(slug)?.has(resolveModelAlias(model))),
            ])],
            reasoning: MODEL_REGISTRY[model]?.reasoning,
            modalities: MODEL_REGISTRY[model]?.modalities,
            topPDeprecatedProviders: topPDeprecatedProviders.length > 0 ? topPDeprecatedProviders : undefined,
          };
        }),
      ...customSlugs.flatMap((slug) => {
        if ((availability.accountCountByProvider.get(slug) ?? 0) === 0) return [];
        return (availability.customProviderStandaloneModels.get(slug) ?? []).map((modelId) => {
          const id = `${slug}/${modelId}`;
          const canonical = resolveModelAlias(modelId);
          return {
            id,
            name: id,
            family: getModelFamily(modelId),
            providers: [slug],
            reasoning: MODEL_REGISTRY[canonical]?.reasoning,
            modalities: MODEL_REGISTRY[canonical]?.modalities,
            topPDeprecatedProviders: undefined,
          };
        });
      }),
    ].sort(compareModelEntries);

    return {
      proxyBaseUrl,
      hasAnyProviderAccount: Number(accountCount?.count ?? 0) > 0 || authlessProviderAccounts.length > 0,
      models,
      providerAccounts: [
        ...authlessProviderAccounts,
        ...providerAccounts.map((account) => ({
        ...account,
        disabledModels: disabledModelsByAccount.get(account.id) ?? [],
        supportedModels: availability.customProviderModels.has(account.provider)
          ? [
              ...Array.from(availability.customProviderModels.get(account.provider) ?? []),
              ...(availability.customProviderStandaloneModels.get(account.provider) ?? []).map((modelId) => `${account.provider}/${modelId}`),
            ]
          : getProviderModelsForAccountTier(account.provider, account.tier),
        })),
      ],
    };
  } catch (error) {
    console.error("Failed to load playground options:", error);
    throw new Error("Failed to load playground options", { cause: error });
  }
}
