import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";

import { db } from "../db/index.js";
import { providerAccount, providerAccountDisabledModel } from "../db/schema.js";
import { getRedisClient } from "../redis.js";
import {
  getAuthlessProviderModels,
  getProviderAccessRule,
  getProvidersForModel,
  resolveModelAlias,
} from "./models.js";
import { AUTHLESS_PROVIDER_KEYS } from "./authless-providers.js";

const DASHBOARD_PROVIDER_ACCOUNT_KEYS = [
  "antigravity",
  "codex",
  "copilot",
  "gemini_cli",
  "kiro",
  "qwen_code",
  "nvidia_nim",
  "openrouter",
  "workers_ai",
  "zenmux",
] as const;

const VALIDATION_PREFIX = "opendum:api-key:validation";
const LAST_USED_PREFIX = "opendum:api-key:last-used";
const DISABLED_MODELS_PREFIX = "opendum:user:disabled-models";

function getApiKeyValidationCacheKey(keyHash: string): string {
  return `${VALIDATION_PREFIX}:${keyHash}`;
}

function getApiKeyLastUsedThrottleKey(apiKeyId: string): string {
  return `${LAST_USED_PREFIX}:${apiKeyId}`;
}

function getDisabledModelsCacheKey(userId: string): string {
  return `${DISABLED_MODELS_PREFIX}:${userId}`;
}

function normalizeTierForProvider(tier: string | null | undefined): string | null {
  if (!tier) return null;
  const normalized = tier.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "pro-plus" || normalized === "proplus") return "pro+";
  if (normalized === "free-tier" || normalized === "free-limited-copilot") return "free";
  if (normalized === "education" || normalized === "educational" || normalized === "edu" || normalized === "free-educational-quota") return "student";
  return normalized || null;
}

function doesAccountTierSatisfyRule(
  accountTier: string | null | undefined,
  minTier: string | null | undefined,
  allowedTiers: string[] | undefined = undefined
): boolean {
  const normalizedAccountTier = normalizeTierForProvider(accountTier);
  if (allowedTiers?.length) {
    return allowedTiers.some((tier) => normalizeTierForProvider(tier) === normalizedAccountTier);
  }

  const normalizedRequiredTier = normalizeTierForProvider(minTier);
  if (!normalizedRequiredTier || normalizedRequiredTier === "free") return true;
  return normalizedAccountTier === normalizedRequiredTier;
}

export async function invalidateDisabledModelsCache(userId: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.del(getDisabledModelsCacheKey(userId));
  } catch {
    // Ignore cache invalidation failures.
  }
}

export async function invalidateApiKeyValidationCache(
  keyHash: string,
  apiKeyId?: string
): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.del(getApiKeyValidationCacheKey(keyHash));
    if (apiKeyId) {
      await redis.del(getApiKeyLastUsedThrottleKey(apiKeyId));
    }
  } catch {
    // Ignore cache invalidation failures.
  }
}

export interface AccountModelAvailability {
  activeProviders: Set<string>;
  accountCountByProvider: Map<string, number>;
  disabledCountByProviderModel: Map<string, number>;
  activeAccountIdsByProvider: Map<string, string[]>;
  accountTierById: Map<string, string>;
  authlessProviderModels: Map<string, Set<string>>;
}

export function isModelUsableByAccounts(
  model: string,
  availability: AccountModelAvailability
): boolean {
  const canonical = resolveModelAlias(model);

  for (const provider of getProvidersForModel(canonical)) {
    const totalAccounts = availability.accountCountByProvider.get(provider) ?? 0;
    if (totalAccounts === 0) continue;
    let effectiveTotalAccounts = totalAccounts;
    const authlessModels = availability.authlessProviderModels.get(provider);
    if (authlessModels && !authlessModels.has(canonical)) {
      effectiveTotalAccounts -= 1;
      if (effectiveTotalAccounts === 0) continue;
    }

    const accessRule = getProviderAccessRule(canonical, provider);
    if (accessRule?.minTier || accessRule?.allowedTiers?.length) {
      const accountIds = availability.activeAccountIdsByProvider.get(provider) ?? [];
      const hasEligibleTierAccount = accountIds.some((accountId) =>
        doesAccountTierSatisfyRule(availability.accountTierById.get(accountId), accessRule.minTier, accessRule.allowedTiers)
      );
      if (!hasEligibleTierAccount) continue;
    }

    const disabledCount = availability.disabledCountByProviderModel.get(`${provider}:${canonical}`) ?? 0;
    if (disabledCount < effectiveTotalAccounts) return true;
  }

  return false;
}

export async function getAccountModelAvailability(
  userId: string,
  options: { includeInactiveAccounts?: boolean } = {}
): Promise<AccountModelAvailability> {
  const accountWhere = options.includeInactiveAccounts
    ? and(eq(providerAccount.userId, userId), inArray(providerAccount.provider, DASHBOARD_PROVIDER_ACCOUNT_KEYS))
    : and(eq(providerAccount.userId, userId), inArray(providerAccount.provider, DASHBOARD_PROVIDER_ACCOUNT_KEYS), eq(providerAccount.isActive, true), or(isNull(providerAccount.disabledUntil), lte(providerAccount.disabledUntil, new Date())));

  const activeAccounts = await db
    .select({
      id: providerAccount.id,
      provider: providerAccount.provider,
      tier: providerAccount.tier,
    })
    .from(providerAccount)
    .where(accountWhere);

  const activeProviders = new Set<string>();
  const accountCountByProvider = new Map<string, number>();
  const accountIdToProvider = new Map<string, string>();
  const activeAccountIdsByProvider = new Map<string, string[]>();
  const accountTierById = new Map<string, string>();
  const authlessProviderModels = new Map<string, Set<string>>();

  for (const provider of AUTHLESS_PROVIDER_KEYS) {
    activeProviders.add(provider);
    accountCountByProvider.set(provider, 1);
    activeAccountIdsByProvider.set(provider, [provider]);
  }

  for (const [provider, models] of Object.entries(getAuthlessProviderModels())) {
    activeProviders.add(provider);
    accountCountByProvider.set(provider, (accountCountByProvider.get(provider) ?? 0) + 1);
    activeAccountIdsByProvider.set(provider, [...(activeAccountIdsByProvider.get(provider) ?? []), `authless:${provider}`]);
    authlessProviderModels.set(provider, new Set(models));
  }

  for (const account of activeAccounts) {
    activeProviders.add(account.provider);
    accountCountByProvider.set(account.provider, (accountCountByProvider.get(account.provider) ?? 0) + 1);
    accountIdToProvider.set(account.id, account.provider);

    const providerAccountIds = activeAccountIdsByProvider.get(account.provider);
    if (providerAccountIds) {
      providerAccountIds.push(account.id);
    } else {
      activeAccountIdsByProvider.set(account.provider, [account.id]);
    }

    const normalizedTier = normalizeTierForProvider(account.tier);
    if (normalizedTier) accountTierById.set(account.id, normalizedTier);
  }

  const disabledCountByProviderModel = new Map<string, number>();
  if (activeAccounts.length > 0) {
    const disabledEntries = await db
      .select({
        providerAccountId: providerAccountDisabledModel.providerAccountId,
        model: providerAccountDisabledModel.model,
      })
      .from(providerAccountDisabledModel)
      .where(inArray(providerAccountDisabledModel.providerAccountId, activeAccounts.map((account) => account.id)));

    for (const entry of disabledEntries) {
      const provider = accountIdToProvider.get(entry.providerAccountId);
      if (!provider) continue;

      const key = `${provider}:${resolveModelAlias(entry.model)}`;
      disabledCountByProviderModel.set(key, (disabledCountByProviderModel.get(key) ?? 0) + 1);
    }
  }

  return {
    activeProviders,
    accountCountByProvider,
    disabledCountByProviderModel,
    activeAccountIdsByProvider,
    accountTierById,
    authlessProviderModels,
  };
}
