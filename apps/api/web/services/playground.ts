import { Effect } from "effect";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db, disabledModel, providerAccount, providerAccountDisabledModel } from "@opendum/database";
import { fromPromise } from "#web/lib/task.js";
import { internal } from "#web/errors.js";
import { getAccountModelAvailability, usable } from "#web/lib/proxy/auth.js";
import { getAuthlessProviderAccounts } from "#web/lib/proxy/authless-providers.js";
import { MODEL_REGISTRY, getAllModels, getModelFamily, getProvidersForModel, resolveModelAlias } from "#web/lib/proxy/models.js";
import { compareModelEntries } from "@opendum/models/sort";
import { getProviderModelsForAccountTier } from "./accounts.js";
import { PROVIDER_ACCOUNT_KEYS } from "./account-providers.js";

function normalizeProxyBaseUrl(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\/$/, "") || undefined : undefined;
}

function getProxyBaseUrl(proxyBaseUrl?: string) {
  return normalizeProxyBaseUrl(proxyBaseUrl) ?? normalizeProxyBaseUrl(process.env.BETTER_AUTH_URL);
}

export const getPlaygroundOptions = Effect.fn("playground.getOptions")(function* (
  userId: string,
  proxyUrl?: string
) {
  return yield* buildPlaygroundOptions(userId, proxyUrl).pipe(
    Effect.mapError((failure) =>
      internal("Failed to load playground options", failure.cause ?? failure)
    )
  );
});

const buildPlaygroundOptions = Effect.fnUntraced(function* (userId: string, proxyUrl?: string) {
  const proxyBaseUrl = getProxyBaseUrl(proxyUrl);
  const [disabledModels, availability] = yield* Effect.all(
    [
      fromPromise(
        () =>
          db
            .select({ model: disabledModel.model })
            .from(disabledModel)
            .where(eq(disabledModel.userId, userId)),
        "Failed to load disabled models"
      ),
      getAccountModelAvailability(userId, { includeInactiveAccounts: true }),
    ],
    { concurrency: "unbounded" }
  );
  const disabledModelSet = new Set(disabledModels.map((entry) => {
    const model = entry.model.trim();
    const canonical = resolveModelAlias(model);
    return getAllModels().includes(canonical) ? canonical : model;
  }));

  const authlessProviderAccounts = getAuthlessProviderAccounts();
  const customSlugs = Array.from(availability.customProviderModels.keys());
  const accountCount = yield* fromPromise(
    () =>
      db
        .select({ count: sql<number>`count(*)` })
        .from(providerAccount)
        .where(eq(providerAccount.userId, userId)),
    "Failed to count provider accounts"
  );

  const providerAccounts = yield* fromPromise(
    () =>
      db
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
    .orderBy(asc(providerAccount.provider), asc(providerAccount.createdAt)),
    "Failed to load provider accounts"
  );

  const disabledModelsByAccount = new Map<string, string[]>();
  if (providerAccounts.length > 0) {
    const perAccountDisabledModels = yield* fromPromise(
      () =>
        db
          .select({ providerAccountId: providerAccountDisabledModel.providerAccountId, model: providerAccountDisabledModel.model })
          .from(providerAccountDisabledModel)
          .where(inArray(providerAccountDisabledModel.providerAccountId, providerAccounts.map((account) => account.id))),
      "Failed to load disabled account models"
    );

    for (const entry of perAccountDisabledModels) {
      const canonical = resolveModelAlias(entry.model);
      const current = disabledModelsByAccount.get(entry.providerAccountId) ?? [];
      current.push(canonical);
      disabledModelsByAccount.set(entry.providerAccountId, current);
    }
  }

  const models = [
    ...getAllModels()
      .filter((model) => !disabledModelSet.has(model) && usable(model, availability))
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
      return (availability.customProviderStandaloneModels.get(slug) ?? []).flatMap((modelId) => {
        const id = `${slug}/${modelId}`;
        if (disabledModelSet.has(id)) return [];
        const canonical = resolveModelAlias(modelId);
        return [{
          id,
          name: id,
          family: getModelFamily(modelId),
          providers: [slug],
          reasoning: MODEL_REGISTRY[canonical]?.reasoning,
          modalities: MODEL_REGISTRY[canonical]?.modalities,
          topPDeprecatedProviders: undefined,
        }];
      });
    }),
  ].sort(compareModelEntries);

  return {
    proxyBaseUrl,
    hasAnyProviderAccount: Number(accountCount[0]?.count ?? 0) > 0 || authlessProviderAccounts.length > 0,
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

});
