import { Effect } from "effect";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";

import { db, customProvider, customProviderModel, providerAccount } from "@opendum/database";
import { fromPromise } from "../task.js";
import { isModelSupported, resolveModelAlias } from "./models.js";

export interface CustomProviderModels {
  slug: string;
  name: string;
  models: string[];
  standaloneModels: string[];
  accountIds: string[];
}

export const listCustomProviderModels = Effect.fn("listCustomProviderModels")(function* (
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

  const accountIdsBySlug = new Map<string, string[]>();
  for (const account of accounts) {
    accountIdsBySlug.set(account.provider, [...(accountIdsBySlug.get(account.provider) ?? []), account.id]);
  }

  const aliasedByProviderId = new Map<string, string[]>();
  const standaloneByProviderId = new Map<string, string[]>();
  for (const model of models) {
    const canonical = resolveModelAlias(model.modelId);
    const aliased = model.aliased && isModelSupported(canonical);
    const target = aliased ? aliasedByProviderId : standaloneByProviderId;
    const value = aliased ? canonical : model.modelId;
    const current = target.get(model.providerId) ?? [];
    if (!current.includes(value)) current.push(value);
    target.set(model.providerId, current);
  }

  return providers.flatMap((provider) => {
    const accountIds = accountIdsBySlug.get(provider.slug) ?? [];
    const aliasedModels = aliasedByProviderId.get(provider.id) ?? [];
    const standaloneModels = standaloneByProviderId.get(provider.id) ?? [];
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
