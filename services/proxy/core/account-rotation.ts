import { Effect } from "effect";
import type { CustomProviderPort, ModelHealthPort, ProviderAccountPort } from "./repositories.js";
import type { SessionAffinity } from "@opendum/core/redis";
import type { AuthResult, ModelValidationResult } from "@opendum/auth";
import type { ProviderAccount, ProviderRegistry } from "@opendum/providers";
import type { Registry } from "@opendum/models/runtime";
import type { AccountHealthService } from "./account-health.js";
import type { ProviderPerformance, ProviderRoutingOptions } from "./provider-performance.js";
import { PriorityOrderStrategy, StickySessionStrategy, composeRoutingStrategies } from "./routing.js";
import {
  accountAccessDenial,
  isSyntheticProviderAccountId,
  normalizeAccessMode,
  normalizeAccountIds,
  proxyAccessRuleRestrictsTier,
  proxyTierSatisfiesRule,
  quotaFallbackTierLocal,
  sortAccountsByProviderPriority,
} from "./service-helpers.js";

/** Result of one account-selection pass. */
export type AccountSelection = { account: ProviderAccount | null; configured: boolean };

export type AccountRotationOptions = {
  accounts: ProviderAccountPort;
  modelHealth: ModelHealthPort;
  customProviders: CustomProviderPort;
  models: Registry;
  providers: ProviderRegistry;
  health: AccountHealthService;
  performance: ProviderPerformance;
  affinity: SessionAffinity;
};

/**
 * Account selection and rotation: eligibility lookup, provider-priority and
 * sticky ordering, health filtering, and session-affinity bookkeeping.
 */
export class AccountRotationService {
  private readonly accounts: ProviderAccountPort;
  private readonly modelHealth: ModelHealthPort;
  private readonly customProviders: CustomProviderPort;
  private readonly models: Registry;
  private readonly providers: ProviderRegistry;
  private readonly health: AccountHealthService;
  private readonly performance: ProviderPerformance;
  private readonly affinity: SessionAffinity;

  constructor(options: AccountRotationOptions) {
    this.accounts = options.accounts;
    this.modelHealth = options.modelHealth;
    this.customProviders = options.customProviders;
    this.models = options.models;
    this.providers = options.providers;
    this.health = options.health;
    this.performance = options.performance;
    this.affinity = options.affinity;
  }

  async nextAttemptAccount(
    authResult: AuthResult,
    validation: ModelValidationResult,
    tried: string[],
    sharedTried: string[],
    excludedProviders: string[],
    useShared: boolean,
    sessionId: string
  ): Promise<AccountSelection> {
    if (useShared) {
      const result = await this.getNextSharedAccount(
        authResult.userId,
        validation.model,
        validation.provider,
        sharedTried,
        excludedProviders
      );
      return { account: result.account, configured: result.configured };
    }
    return this.getNextAvailableAccount(
      authResult.userId,
      validation.model,
      validation.provider,
      tried,
      excludedProviders,
      { mode: authResult.accountAccessMode, accounts: authResult.accountAccessList },
      sessionId
    );
  }

  canAccountUseModel(account: ProviderAccount, model: string): boolean {
    const rule = this.models.providerAccessRule(model, account.provider);
    if (!rule || !proxyAccessRuleRestrictsTier(rule.minTier, rule.allowedTiers)) return true;
    const tier = account.tier ?? quotaFallbackTierLocal(account);
    return proxyTierSatisfiesRule(tier, rule.minTier, rule.allowedTiers);
  }

  private async getNextAvailableAccount(
    userId: string,
    model: string,
    provider: string | null,
    exclude: string[],
    excludeProviders: string[],
    accountAccess: { mode: string; accounts: string[] },
    sessionId: string
  ): Promise<AccountSelection> {
    const eligible = await this.getEligibleAccounts(userId, model, provider, exclude, excludeProviders, accountAccess);
    if (eligible.length === 0) return { account: null, configured: false };
    const routing = await this.performanceRouting(model, provider === null);
    const stickyId = await this.affinity.lookup(userId, sessionId);
    const strategy = composeRoutingStrategies(new PriorityOrderStrategy(), new StickySessionStrategy(stickyId));
    const prioritized = strategy.order(eligible, {
      crossProvider: provider === null,
      providerPriority: this.models.providersForModel(model),
      routingOptions: routing,
    });
    const selected = await this.pickHealthyAccount(prioritized, model);
    if (!selected) return { account: null, configured: true };
    await this.rememberAffinityAccount(userId, sessionId, selected);
    return { account: selected, configured: true };
  }

  private async getNextSharedAccount(
    _userId: string,
    model: string,
    provider: string | null,
    exclude: string[],
    excludeProviders: string[]
  ): Promise<AccountSelection> {
    const targetProviders = provider ? [provider] : this.models.providersForModel(model);
    if (targetProviders.length === 0) return { account: null, configured: false };
    const now = new Date();
    const sharedRows = await this.accounts.listSharedEligibleAccounts(
      { userId: _userId, providers: targetProviders, now, excludeIds: exclude, excludeProviders }
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
    const lookupKeys = this.models.lookupKeys(model);
    const ids = rows.map((row) => row.id);
    const disabled = await this.accounts.listDisabledAccountIDs({ accountIds: ids, models: lookupKeys });
    const disabledSet = new Set(disabled.map((row) => row.providerAccountId));
    const enabled = rows.filter((row) => !disabledSet.has(row.id) && this.canAccountUseModel(row, model));
    if (enabled.length === 0) return { account: null, configured: true };
    const routing = await this.performanceRouting(model, provider === null);
    const prioritized = new PriorityOrderStrategy().order(enabled, {
      crossProvider: provider === null,
      providerPriority: targetProviders,
      routingOptions: routing,
    });
    return { account: await this.pickHealthyAccount(prioritized, model), configured: true };
  }

  private async getEligibleAccounts(
    userId: string,
    model: string,
    provider: string | null,
    exclude: string[],
    excludeProviders: string[],
    accountAccess: { mode: string; accounts: string[] }
  ): Promise<ProviderAccount[]> {
    const targetProviders = provider
      ? [provider]
      : [...new Set([...this.models.providersForModel(model), ...(await this.customProviderSlugsForModel(userId, model))])];
    if (targetProviders.length === 0) return [];

    const rows: ProviderAccount[] = [];
    for (const targetProvider of targetProviders) {
      let account: ProviderAccount | null = null;
      if (this.providers.isAuthless(targetProvider)) {
        account = { id: targetProvider, userId: "", provider: targetProvider, isActive: true, status: "active" };
      } else if (this.models.isAuthlessProviderModel(model, targetProvider)) {
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
    const dbRows = await this.accounts.listEligibleAccounts(
      {
        userId,
        providers: targetProviders,
        now,
        excludeIds: exclude,
        excludeProviders,
        useWhitelist: mode === "whitelist" && accounts.length > 0,
        accountIds: accounts,
        useBlacklist: mode === "blacklist" && accounts.length > 0,
      }
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

    const lookupKeys = this.models.lookupKeys(model);
    const ids = rows.map((row) => row.id);
    const disabled = await this.accounts.listDisabledAccountIDs({ accountIds: ids, models: lookupKeys });
    const disabledSet = new Set(disabled.map((row) => row.providerAccountId));
    const enabled = rows.filter(
      (row) => isSyntheticProviderAccountId(row.id) || (!disabledSet.has(row.id) && this.canAccountUseModel(row, model))
    );
    if (provider === null) sortAccountsByProviderPriority(enabled, targetProviders);
    return enabled;
  }

  private async customProviderSlugsForModel(userId: string, model: string): Promise<string[]> {
    const providers = await this.customProviders.listCustomProviders(userId);
    if (providers.length === 0) return [];
    const canonical = this.models.resolveAlias(model);
    const results = await Effect.runPromise(
      Effect.forEach(
        providers,
        (custom) =>
          Effect.promise(() => this.customProviders.listCustomProviderModels(custom.id)).pipe(
            Effect.map((rows) =>
              rows.some((row) => row.aliased && this.models.resolveAlias(row.modelId) === canonical)
                ? custom.slug
                : null
            )
          ),
        { concurrency: 4 }
      )
    );
    return results.filter((slug): slug is string => slug !== null);
  }

  private async performanceRouting(model: string, enabled: boolean): Promise<ProviderRoutingOptions | undefined> {
    if (!enabled) return undefined;
    const scores = await this.performance.scoresForModel(this.models.resolveAlias(model));
    if (scores.size === 0) return undefined;
    return this.performance.routingOptions(scores);
  }

  private async pickHealthyAccount(
    prioritized: ProviderAccount[],
    model: string
  ): Promise<ProviderAccount | null> {
    const now = new Date();
    const lookupKeys = this.models.lookupKeys(model);
    let degraded: ProviderAccount | null = null;
    for (const account of prioritized) {
      if (isSyntheticProviderAccountId(account.id)) return account;
      const coolingDown = await this.health.refreshAccountHealthFromModels(account.id, now);
      if (coolingDown) continue;
      const health = await this.modelHealth.getModelHealth(account.id, this.models.resolveAlias(model));
      if (health && health.status === "degraded") {
        if (!degraded) degraded = account;
        continue;
      }
      void lookupKeys;
      this.health.bumpRequestCount(account.id);
      return account;
    }
    if (degraded) this.health.bumpRequestCount(degraded.id);
    return degraded;
  }

  private async rememberAffinityAccount(
    userId: string,
    sessionId: string,
    account: ProviderAccount
  ): Promise<void> {
    if (!sessionId || isSyntheticProviderAccountId(account.id)) return;
    if (!this.affinity.enabled(account.provider)) return;
    await this.affinity.store(userId, sessionId, account.id);
  }
}
