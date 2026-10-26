import { Effect } from "effect";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";

import { db, customProvider, customProviderModel, providerAccount } from "@opendum/database";
import { fromPromise } from "../task.js";
import { supportsModel, aliasOf } from "./models.js";

export interface CustomProviderModels {
  slug: string;
  name: string;
  models: string[];
  standaloneModels: string[];
  accountIds: string[];
}

export const customModels = Effect.fn("customModels")(function* (
  userId: string,
  options: { includeInactiveAccounts?: boolean } = {}
) {
  const providers = yield* fromPromise(
    () =>
      db
        .select({ id: customProvider.id, slug: customProvider.slug, name: customProvider.name })
        .from(customProvider)
        .where(and(eq(customProvider.userId, userId), eq(customProvider.enabled, true))),
    "Failed to load custom providers"
  );
  if (providers.length === 0) return [] as CustomProviderModels[];

  const providerIds = providers.map((provider) => provider.id);
  const slugs = providers.map((provider) => provider.slug);
  const accountWhere = options.includeInactiveAccounts
    ? and(eq(providerAccount.userId, userId), inArray(providerAccount.provider, slugs))
    : and(
        eq(providerAccount.userId, userId),
        inArray(providerAccount.provider, slugs),
        eq(providerAccount.isActive, true),
        or(isNull(providerAccount.disabledUntil), lte(providerAccount.disabledUntil, new Date()))
      );

  const [models, accounts] = yield* Effect.all(
    [
      fromPromise(
        () =>
          db
            .select({
              providerId: customProviderModel.providerId,
              modelId: customProviderModel.modelId,
              aliased: customProviderModel.aliased,
            })
            .from(customProviderModel)
            .where(inArray(customProviderModel.providerId, providerIds)),
        "Failed to load custom provider models"
      ),
      fromPromise(
        () =>
          db
            .select({ id: providerAccount.id, provider: providerAccount.provider })
            .from(providerAccount)
            .where(accountWhere),
        "Failed to load custom provider accounts"
      ),
    ],
    { concurrency: "unbounded" }
  );

  const idsBySlug = new Map<string, string[]>();
  for (const account of accounts) {
    idsBySlug.set(account.provider, [...(idsBySlug.get(account.provider) ?? []), account.id]);
  }

  const aliasedByProvider = new Map<string, string[]>();
  const standaloneByProvider = new Map<string, string[]>();
  for (const model of models) {
    const canonical = aliasOf(model.modelId);
    const aliased = model.aliased && supportsModel(canonical);
    const target = aliased ? aliasedByProvider : standaloneByProvider;
    const value = aliased ? canonical : model.modelId;
    const current = target.get(model.providerId) ?? [];
    if (!current.includes(value)) current.push(value);
    target.set(model.providerId, current);
  }

  return providers.flatMap((provider) => {
    const accountIds = idsBySlug.get(provider.slug) ?? [];
    const aliasedModels = aliasedByProvider.get(provider.id) ?? [];
    const standaloneModels = standaloneByProvider.get(provider.id) ?? [];
    if (accountIds.length === 0 || (aliasedModels.length === 0 && standaloneModels.length === 0)) return [];
    return [
      {
        slug: provider.slug,
        name: provider.name,
        models: aliasedModels,
        standaloneModels,
        accountIds,
      } satisfies CustomProviderModels,
    ];
  });
});
