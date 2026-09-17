import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";

import { db, customProvider, customProviderModel, providerAccount } from "@opendum/database";
import { isModelSupported, resolveModelAlias } from "./models.js";

export interface CustomProviderModels {
  slug: string;
  name: string;
  /** Model ids that resolve to a built-in model, as canonical ids. */
  models: string[];
  /** Model ids without a built-in counterpart, kept verbatim. */
  standaloneModels: string[];
  accountIds: string[];
}

/**
 * Enabled custom providers, keyed by provider slug. A provider is only
 * returned when it has at least one usable account and at least one model.
 */
export async function listCustomProviderModels(userId: string, options: { includeInactiveAccounts?: boolean } = {}): Promise<CustomProviderModels[]> {
  const providers = await db
    .select({ id: customProvider.id, slug: customProvider.slug, name: customProvider.name })
    .from(customProvider)
    .where(and(eq(customProvider.userId, userId), eq(customProvider.enabled, true)));
  if (providers.length === 0) return [];

  const providerIds = providers.map((provider) => provider.id);
  const slugs = providers.map((provider) => provider.slug);
  const accountWhere = options.includeInactiveAccounts
    ? and(eq(providerAccount.userId, userId), inArray(providerAccount.provider, slugs))
    : and(
        eq(providerAccount.userId, userId),
        inArray(providerAccount.provider, slugs),
        eq(providerAccount.isActive, true),
        or(isNull(providerAccount.disabledUntil), lte(providerAccount.disabledUntil, new Date())),
      );

  const [models, accounts] = await Promise.all([
    db
      .select({ providerId: customProviderModel.providerId, modelId: customProviderModel.modelId, aliased: customProviderModel.aliased })
      .from(customProviderModel)
      .where(inArray(customProviderModel.providerId, providerIds)),
    db.select({ id: providerAccount.id, provider: providerAccount.provider }).from(providerAccount).where(accountWhere),
  ]);

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
    const value = target === aliasedByProviderId ? canonical : model.modelId;
    const current = target.get(model.providerId) ?? [];
    if (!current.includes(value)) current.push(value);
    target.set(model.providerId, current);
  }

  return providers.flatMap((provider) => {
    const accountIds = accountIdsBySlug.get(provider.slug) ?? [];
    const modelsForProvider = aliasedByProviderId.get(provider.id) ?? [];
    const standaloneModels = standaloneByProviderId.get(provider.id) ?? [];
    if (accountIds.length === 0 || (modelsForProvider.length === 0 && standaloneModels.length === 0)) return [];
    return [{ slug: provider.slug, name: provider.name, models: modelsForProvider, standaloneModels, accountIds }];
  });
}
