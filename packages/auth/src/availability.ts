import type { Registry } from "@opendum/models/runtime";
import {
  listActiveAccountTiers,
  listDisabledModelsByAccounts,
  listSharedAccounts,
} from "@opendum/database/queries";
import type { AccountModelAvailability } from "#auth/types.ts";
import { emptyAvailability } from "#auth/types.ts";
import { AUTHLESS_PROVIDER_NAMES, accessRuleRestrictsTier, tierSatisfiesRule } from "#auth/helpers.ts";

export type CustomProviderModelSets = {
  aliased: Map<string, Set<string>>;
  standalone: Map<string, string[]>;
};

export async function computeAccountModelAvailability(
  registry: Registry,
  customProviderModelSets: (userId: string) => Promise<CustomProviderModelSets>,
  userId: string,
  includeShared: boolean,
  options: { includeInactiveAccounts?: boolean } = {}
): Promise<AccountModelAvailability> {
  const availability = emptyAvailability();

  for (const provider of AUTHLESS_PROVIDER_NAMES) {
    availability.activeProviders.add(provider);
    availability.accountCountByProvider.set(provider, 1);
    availability.activeAccountIdsByProvider.set(provider, [provider]);
  }
  for (const [provider, models] of registry.authlessProviderModels()) {
    if (models.length === 0) continue;
    availability.activeProviders.add(provider);
    availability.accountCountByProvider.set(
      provider,
      (availability.accountCountByProvider.get(provider) ?? 0) + 1
    );
    availability.activeAccountIdsByProvider.set(provider, [
      ...(availability.activeAccountIdsByProvider.get(provider) ?? []),
      provider,
    ]);
    const set = availability.authlessProviderModels.get(provider) ?? new Set<string>();
    for (const model of models) set.add(model);
    availability.authlessProviderModels.set(provider, set);
  }

  const now = new Date();
  const accounts = await listActiveAccountTiers(userId, now, options.includeInactiveAccounts === true);
  const accountProvider = new Map<string, string>();
  const accountIds: string[] = [];
  for (const account of accounts) {
    availability.activeProviders.add(account.provider);
    availability.accountCountByProvider.set(
      account.provider,
      (availability.accountCountByProvider.get(account.provider) ?? 0) + 1
    );
    const list = availability.activeAccountIdsByProvider.get(account.provider) ?? [];
    list.push(account.id);
    availability.activeAccountIdsByProvider.set(account.provider, list);
    accountProvider.set(account.id, account.provider);
    accountIds.push(account.id);
    if (account.tier && account.tier.trim()) {
      availability.accountTierById.set(account.id, account.tier.trim().toLowerCase());
    }
  }

  if (accountIds.length > 0) {
    const disabledRows = await listDisabledModelsByAccounts(accountIds);
    for (const row of disabledRows) {
      const provider = accountProvider.get(row.providerAccountId);
      if (!provider) continue;
      const key = `${provider}:${registry.resolveAlias(row.model)}`;
      availability.disabledCountByProviderModel.set(
        key,
        (availability.disabledCountByProviderModel.get(key) ?? 0) + 1
      );
    }
  }

  const { aliased, standalone } = await customProviderModelSets(userId);
  for (const [slug, models] of aliased) {
    if ((availability.accountCountByProvider.get(slug) ?? 0) === 0) continue;
    availability.customProviderModels.set(slug, models);
  }
  for (const [slug, models] of standalone) {
    availability.customProviderStandaloneModels.set(slug, models);
  }

  if (!includeShared) return availability;

  const sharedAccounts = await listSharedAccounts(userId, now);
  const sharedAccountProvider = new Map<string, string>();
  const sharedAccountIds: string[] = [];
  for (const account of sharedAccounts) {
    availability.sharedAccountCountByProvider.set(
      account.provider,
      (availability.sharedAccountCountByProvider.get(account.provider) ?? 0) + 1
    );
    sharedAccountProvider.set(account.id, account.provider);
    sharedAccountIds.push(account.id);
    if (account.tier && account.tier.trim()) {
      const list = availability.sharedAccountTiersByProvider.get(account.provider) ?? [];
      list.push(account.tier.trim().toLowerCase());
      availability.sharedAccountTiersByProvider.set(account.provider, list);
    }
  }
  if (sharedAccountIds.length > 0) {
    const disabledRows = await listDisabledModelsByAccounts(sharedAccountIds);
    for (const row of disabledRows) {
      const provider = sharedAccountProvider.get(row.providerAccountId);
      if (!provider) continue;
      const key = `${provider}:${registry.resolveAlias(row.model)}`;
      availability.sharedDisabledCountByProviderModel.set(
        key,
        (availability.sharedDisabledCountByProviderModel.get(key) ?? 0) + 1
      );
    }
  }

  return availability;
}

export function isModelUsableByAccounts(
  registry: Registry,
  model: string,
  availability: AccountModelAvailability
): boolean {
  const canonical = registry.resolveAlias(model);
  for (const provider of registry.providersForModel(canonical)) {
    let total = availability.accountCountByProvider.get(provider) ?? 0;
    if (total === 0) continue;
    const authlessModels = availability.authlessProviderModels.get(provider);
    if (authlessModels && !authlessModels.has(canonical)) {
      if (total === 1) continue;
      total -= 1;
    }
    const rule = registry.providerAccessRule(canonical, provider);
    if (rule && accessRuleRestrictsTier(rule.minTier, rule.allowedTiers)) {
      const accountIds = availability.activeAccountIdsByProvider.get(provider) ?? [];
      const eligible = accountIds.some((accountId) =>
        tierSatisfiesRule(
          availability.accountTierById.get(accountId) ?? "",
          rule.minTier,
          rule.allowedTiers
        )
      );
      if (!eligible) continue;
    }
    const disabled = availability.disabledCountByProviderModel.get(`${provider}:${canonical}`) ?? 0;
    if (disabled < total) return true;
  }
  for (const [provider, models] of availability.customProviderModels) {
    if (!models.has(canonical)) continue;
    if ((availability.accountCountByProvider.get(provider) ?? 0) > 0) return true;
  }
  return false;
}

export function isModelUsableBySharedAccounts(
  registry: Registry,
  model: string,
  availability: AccountModelAvailability
): boolean {
  const canonical = registry.resolveAlias(model);
  for (const provider of registry.providersForModel(canonical)) {
    const total = availability.sharedAccountCountByProvider.get(provider) ?? 0;
    if (total === 0) continue;
    const rule = registry.providerAccessRule(canonical, provider);
    if (rule && accessRuleRestrictsTier(rule.minTier, rule.allowedTiers)) {
      const tiers = availability.sharedAccountTiersByProvider.get(provider) ?? [];
      const eligible = tiers.some((tier) =>
        tierSatisfiesRule(tier, rule.minTier, rule.allowedTiers)
      );
      if (!eligible) continue;
    }
    const disabled = availability.sharedDisabledCountByProviderModel.get(`${provider}:${canonical}`) ?? 0;
    if (disabled < total) return true;
  }
  return false;
}
