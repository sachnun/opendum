import {
  getModelHealth,
  listCustomProviderModels,
  listCustomProviders,
  listDisabledAccountIDs,
  listEligibleAccounts,
  listSharedEligibleAccounts,
} from "@opendum/database/queries";
import type { ProviderAccount } from "@opendum/providers";
import { preferSticky } from "@opendum/redis";

import type { ProviderRoutingOptions } from "./health/provider-performance.ts";
import type { ProxyDeps } from "./service-deps.ts";
import { bumpAccountRequestCountDeferred, refreshAccountHealthFromModels } from "./health/service-health.ts";
import {
  accountAccessDenial,
  isSyntheticProviderAccountId,
  normalizeAccessMode,
  normalizeAccountIds,
  prioritizeAccounts,
  proxyAccessRuleRestrictsTier,
  proxyTierSatisfiesRule,
  quotaFallbackTierLocal,
  sortAccountsByProviderPriority,
} from "./transport/service-helpers.ts";

export function canAccountUseModel(deps: ProxyDeps, account: ProviderAccount, model: string): boolean {
  const rule = deps.models.providerAccessRule(model, account.provider);
  if (!rule || !proxyAccessRuleRestrictsTier(rule.minTier, rule.allowedTiers)) return true;
  const tier = account.tier ?? quotaFallbackTierLocal(account);
  return proxyTierSatisfiesRule(tier, rule.minTier, rule.allowedTiers);
}

async function customProviderSlugsForModel(deps: ProxyDeps, userId: string, model: string): Promise<string[]> {
  const providers = await listCustomProviders(userId, deps.database);
  if (providers.length === 0) return [];
  const canonical = deps.models.resolveAlias(model);
  const slugs: string[] = [];
  for (const custom of providers) {
    const rows = await listCustomProviderModels(custom.id, deps.database);
    if (rows.some((row) => row.aliased && deps.models.resolveAlias(row.modelId) === canonical)) {
      slugs.push(custom.slug);
    }
  }
  return slugs;
}

async function getEligibleAccounts(
  deps: ProxyDeps,
  userId: string,
  model: string,
  provider: string | null,
  exclude: string[],
  excludeProviders: string[],
  accountAccess: { mode: string; accounts: string[] }
): Promise<ProviderAccount[]> {
  const targetProviders = provider
    ? [provider]
    : [
        ...new Set([
          ...deps.models.providersForModel(model),
          ...(await customProviderSlugsForModel(deps, userId, model)),
        ]),
      ];
  if (targetProviders.length === 0) return [];

  const rows: ProviderAccount[] = [];
  for (const targetProvider of targetProviders) {
    let account: ProviderAccount | null = null;
    if (deps.providers.isAuthless(targetProvider)) {
      account = { id: targetProvider, userId: "", provider: targetProvider, isActive: true, status: "active" };
    } else if (deps.models.isAuthlessProviderModel(model, targetProvider)) {
      account = {
        id: `authless:${targetProvider}`,
        userId: "",
        provider: targetProvider,
        isActive: true,
        status: "active",
      };
    }
    if (!account) continue;
    if (exclude.includes(account.id)) continue;
    if (excludeProviders.includes(account.provider)) continue;
    if (accountAccessDenial(account.id, accountAccess)) continue;
    rows.push(account);
  }

  const now = new Date();
  const mode = normalizeAccessMode(accountAccess.mode);
  const accounts = normalizeAccountIds(accountAccess.accounts);
  const dbRows = await listEligibleAccounts(
    {
      userId,
      providers: targetProviders,
      now,
      excludeIds: exclude,
      excludeProviders,
      useWhitelist: mode === "whitelist" && accounts.length > 0,
      accountIds: accounts,
      useBlacklist: mode === "blacklist" && accounts.length > 0,
    },
    deps.database
  );
  for (const row of dbRows) {
    rows.push({
      id: row.id,
      userId: row.userId,
      provider: row.provider,
      tier: row.tier,
      accountId: row.accountId,
      status: row.status,
      disabledUntil: row.disabledUntil,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
    });
  }
  if (rows.length === 0) return [];

  const lookupKeys = deps.models.lookupKeys(model);
  const ids = rows.map((row) => row.id);
  const disabled = await listDisabledAccountIDs({ accountIds: ids, models: lookupKeys }, deps.database);
  const disabledSet = new Set(disabled.map((row) => row.providerAccountId));
  const enabled = rows.filter(
    (row) =>
      isSyntheticProviderAccountId(row.id) || (!disabledSet.has(row.id) && canAccountUseModel(deps, row, model))
  );
  if (provider === null) sortAccountsByProviderPriority(enabled, targetProviders);
  return enabled;
}

export async function getNextAvailableAccount(
  deps: ProxyDeps,
  userId: string,
  model: string,
  provider: string | null,
  exclude: string[],
  excludeProviders: string[],
  accountAccess: { mode: string; accounts: string[] },
  sessionId: string
): Promise<{ account: ProviderAccount | null; configured: boolean }> {
  const eligible = await getEligibleAccounts(
    deps,
    userId,
    model,
    provider,
    exclude,
    excludeProviders,
    accountAccess
  );
  if (eligible.length === 0) return { account: null, configured: false };
  const routing = await performanceRouting(deps, model, provider === null);
  let prioritized = prioritizeAccounts(eligible, provider === null, deps.models.providersForModel(model), routing);
  const stickyId = await deps.affinity.lookup(userId, sessionId);
  if (stickyId && !isSyntheticProviderAccountId(stickyId)) {
    prioritized = preferSticky(prioritized, (account) => account.id === stickyId);
  }
  const selected = await pickHealthyAccount(deps, prioritized, model);
  if (!selected) return { account: null, configured: true };
  await rememberAffinityAccount(deps, userId, sessionId, selected);
  return { account: selected, configured: true };
}

export async function getNextSharedAccount(
  deps: ProxyDeps,
  userId: string,
  model: string,
  provider: string | null,
  exclude: string[],
  excludeProviders: string[]
): Promise<{ account: ProviderAccount | null; configured: boolean }> {
  const targetProviders = provider ? [provider] : deps.models.providersForModel(model);
  if (targetProviders.length === 0) return { account: null, configured: false };
  const now = new Date();
  const sharedRows = await listSharedEligibleAccounts(
    { userId, providers: targetProviders, now, excludeIds: exclude, excludeProviders },
    deps.database
  );
  const rows: ProviderAccount[] = sharedRows.map((row) => ({
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    tier: row.tier,
    accountId: row.accountId,
    status: row.status,
    disabledUntil: row.disabledUntil,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  }));
  if (rows.length === 0) return { account: null, configured: false };
  const lookupKeys = deps.models.lookupKeys(model);
  const ids = rows.map((row) => row.id);
  const disabled = await listDisabledAccountIDs({ accountIds: ids, models: lookupKeys }, deps.database);
  const disabledSet = new Set(disabled.map((row) => row.providerAccountId));
  const enabled = rows.filter((row) => !disabledSet.has(row.id) && canAccountUseModel(deps, row, model));
  if (enabled.length === 0) return { account: null, configured: true };
  const routing = await performanceRouting(deps, model, provider === null);
  const prioritized = prioritizeAccounts(enabled, provider === null, targetProviders, routing);
  return { account: await pickHealthyAccount(deps, prioritized, model), configured: true };
}

async function performanceRouting(
  deps: ProxyDeps,
  model: string,
  enabled: boolean
): Promise<ProviderRoutingOptions | undefined> {
  if (!enabled) return undefined;
  const scores = await deps.performance.scoresForModel(deps.models.resolveAlias(model));
  if (scores.size === 0) return undefined;
  return deps.performance.routingOptions(scores);
}

async function pickHealthyAccount(
  deps: ProxyDeps,
  prioritized: ProviderAccount[],
  model: string
): Promise<ProviderAccount | null> {
  const now = new Date();
  const lookupKeys = deps.models.lookupKeys(model);
  let degraded: ProviderAccount | null = null;
  for (const account of prioritized) {
    if (isSyntheticProviderAccountId(account.id)) return account;
    const coolingDown = await refreshAccountHealthFromModels(deps, account.id, now);
    if (coolingDown) continue;
    const health = await getModelHealth(account.id, deps.models.resolveAlias(model), deps.database);
    if (health && health.status === "degraded") {
      if (!degraded) degraded = account;
      continue;
    }
    void lookupKeys;
    void bumpAccountRequestCountDeferred(deps, account.id);
    return account;
  }
  if (degraded) void bumpAccountRequestCountDeferred(deps, degraded.id);
  return degraded;
}

async function rememberAffinityAccount(
  deps: ProxyDeps,
  userId: string,
  sessionId: string,
  account: ProviderAccount
): Promise<void> {
  if (!sessionId || isSyntheticProviderAccountId(account.id)) return;
  if (!deps.affinity.enabled(account.provider)) return;
  await deps.affinity.store(userId, sessionId, account.id);
}
