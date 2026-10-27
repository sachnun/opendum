import { Effect } from "effect";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db, disabledModel, providerAccount, accountDisabledModel } from "@opendum/database";
import { fromPromise } from "@opendum/api/web/lib/task";
import { internal } from "@opendum/api/web/errors";
import { modelAvailability, usable } from "@opendum/api/web/lib/proxy/auth";
import { authlessAccounts } from "@opendum/api/web/lib/proxy/authless-providers";
import { MODEL_REGISTRY, allModels, familyOf, providersFor, aliasOf } from "@opendum/api/web/lib/proxy/models";
import { compareEntries } from "@opendum/models/sort";
import { Tier } from "@opendum/api/web/services/accounts-helpers";
import { PROVIDER_ACCOUNT_KEYS } from "@opendum/api/web/services/account-providers";

function normalizeUrl(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\/$/, "") || undefined : undefined;
}

function resolveUrl(proxyUrl?: string) {
  return normalizeUrl(proxyUrl) ?? normalizeUrl(process.env.BETTER_AUTH_URL);
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
  const proxyBaseUrl = resolveUrl(proxyUrl);
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
      modelAvailability(userId, { includeInactiveAccounts: true }),
    ],
    { concurrency: "unbounded" }
  );
  const disabledModelSet = new Set(disabledModels.map((entry) => {
    const model = entry.model.trim();
    const canonical = aliasOf(model);
    return allModels().includes(canonical) ? canonical : model;
  }));

  const authlessProviderAccounts = authlessAccounts();
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

  const disabledByAccount = new Map<string, string[]>();
  if (providerAccounts.length > 0) {
    const accountDisabledModels = yield* fromPromise(
      () =>
        db
          .select({ providerAccountId: accountDisabledModel.providerAccountId, model: accountDisabledModel.model })
          .from(accountDisabledModel)
          .where(inArray(accountDisabledModel.providerAccountId, providerAccounts.map((account) => account.id))),
      "Failed to load disabled account models"
    );

    for (const entry of accountDisabledModels) {
      const canonical = aliasOf(entry.model);
      const current = disabledByAccount.get(entry.providerAccountId) ?? [];
      current.push(canonical);
      disabledByAccount.set(entry.providerAccountId, current);
    }
  }

  const models = [
    ...allModels()
      .filter((model) => !disabledModelSet.has(model) && usable(model, availability))
      .map((model) => {
        const providerConfigs = MODEL_REGISTRY[model]?.providerConfig ?? {};
        const deprecatedProviders = Object.entries(providerConfigs)
          .filter(([, cfg]) => (cfg as Record<string, unknown>).top_p_deprecated === true)
          .map(([provider]) => provider);

        return {
          id: model,
          name: model,
          family: familyOf(model),
          providers: [...new Set([
            ...providersFor(model).filter((provider) => availability.activeProviders.has(provider)),
            ...customSlugs.filter((slug) => availability.customProviderModels.get(slug)?.has(aliasOf(model))),
          ])],
          reasoning: MODEL_REGISTRY[model]?.reasoning,
          modalities: MODEL_REGISTRY[model]?.modalities,
          deprecatedProviders: deprecatedProviders.length > 0 ? deprecatedProviders : undefined,
        };
      }),
    ...customSlugs.flatMap((slug) => {
      if ((availability.accountCountByProvider.get(slug) ?? 0) === 0) return [];
      return (availability.customProviderStandaloneModels.get(slug) ?? []).flatMap((modelId) => {
        const id = `${slug}/${modelId}`;
        if (disabledModelSet.has(id)) return [];
        const canonical = aliasOf(modelId);
        return [{
          id,
          name: id,
          family: familyOf(modelId),
          providers: [slug],
          reasoning: MODEL_REGISTRY[canonical]?.reasoning,
          modalities: MODEL_REGISTRY[canonical]?.modalities,
          deprecatedProviders: undefined,
        }];
      });
    }),
  ].sort(compareEntries);

  return {
    proxyBaseUrl,
    hasAnyProviderAccount: Number(accountCount[0]?.count ?? 0) > 0 || authlessProviderAccounts.length > 0,
    models,
    providerAccounts: [
      ...authlessProviderAccounts,
      ...providerAccounts.map((account) =>
        Object.assign(account, {
          disabledModels: disabledByAccount.get(account.id) ?? [],
          supportedModels: availability.customProviderModels.has(account.provider)
            ? [
                ...Array.from(availability.customProviderModels.get(account.provider) ?? []),
                ...(availability.customProviderStandaloneModels.get(account.provider) ?? []).map((modelId) => `${account.provider}/${modelId}`),
              ]
            : Tier.modelsFor(account.provider, account.tier),
        })
      ),
    ],
  };

});
