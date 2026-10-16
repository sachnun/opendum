import { Effect } from "effect";
import type { CustomPort, HealthPort, AccountPort } from "./repositories.js";
import type { SessionAffinity } from "@opendum/core/redis";
import type { AuthResult, ModelValidationResult } from "@opendum/auth";
import type { ProviderAccount, ProviderRegistry } from "@opendum/providers";
import type { Registry } from "@opendum/models/runtime";
import type { Health } from "./health.js";
import type { ProviderPerformance, ProviderRoutingOptions } from "./provider-performance.js";
import { Priority, Sticky, compose } from "./routing.js";
import {
  accountAccessDenial,
  isSyntheticProviderAccountId,
  accessMode,
  normalizeAccountIds,
  proxyAccessRuleRestrictsTier,
  proxyTierSatisfiesRule,
  quotaFallbackTierLocal,
  sortAccountsByProviderPriority,
} from "./service-helpers.js";

/** Result of one account-selection pass. */
export type Selection = { account: ProviderAccount | null; configured: boolean };

export type Options = {
  accounts: AccountPort;
  modelHealth: HealthPort;
  customProviders: CustomPort;
  models: Registry;
  providers: ProviderRegistry;
  health: Health;
  performance: ProviderPerformance;
  affinity: SessionAffinity;
};

/**
 * Account selection and rotation: eligibility lookup, provider-priority and
 * sticky ordering, health filtering, and session-affinity bookkeeping.
 */
export class Rotation {
  private readonly accounts: AccountPort;
  private readonly modelHealth: HealthPort;
  private readonly customProviders: CustomPort;
  private readonly models: Registry;
  private readonly providers: ProviderRegistry;
  private readonly health: Health;
  private readonly performance: ProviderPerformance;
  private readonly affinity: SessionAffinity;

  constructor(options: Options) {
    this.accounts = options.accounts;
    this.modelHealth = options.modelHealth;
    this.customProviders = options.customProviders;
    this.models = options.models;
    this.providers = options.providers;
    this.health = options.health;
    this.performance = options.performance;
    this.affinity = options.affinity;
  }

  async nextAccount(
    authResult: AuthResult,
    validation: ModelValidationResult,
    tried: string[],
    sharedTried: string[],
    excludedProviders: string[],
    useShared: boolean,
    sessionId: string
  ): Promise<Selection> {
    if (useShared) {
      const result = await this.nextShared(
        authResult.userId,
        validation.model,
        validation.provider,
        sharedTried,
        excludedProviders
      );
      return { account: result.account, configured: result.configured };
    }
    return this.nextAvailable(
      authResult.userId,
      validation.model,
      validation.provider,
      tried,
      excludedProviders,
      { mode: authResult.accountAccessMode, accounts: authResult.accountAccessList },
      sessionId
    );
  }

  canUse(account: ProviderAccount, model: string): boolean {
    const rule = this.models.rule(model, account.provider);
    if (!rule || !proxyAccessRuleRestrictsTier(rule.minTier, rule.allowedTiers)) return true;
    const tier = account.tier ?? quotaFallbackTierLocal(account);
    return proxyTierSatisfiesRule(tier, rule.minTier, rule.allowedTiers);
  }

  private async nextAvailable(
    userId: string,
    model: string,
    provider: string | null,
    exclude: string[],
    excludeProviders: string[],
    accountAccess: { mode: string; accounts: string[] },
    sessionId: string
  ): Promise<Selection> {
    const eligible = await this.eligible(userId, model, provider, exclude, excludeProviders, accountAccess);
    if (eligible.length === 0) return { account: null, configured: false };
    const routing = await this.routing(model, provider === null);
    const stickyId = await this.affinity.lookup(userId, sessionId);
    const strategy = compose(new Priority(), new Sticky(stickyId));
    const prioritized = strategy.order(eligible, {
      crossProvider: provider === null,
      priority: this.models.providers(model),
      routingOptions: routing,
    });
    const selected = await this.pickHealthy(prioritized, model);
    if (!selected) return { account: null, configured: true };
    await this.remember(userId, sessionId, selected);
    return { account: selected, configured: true };
  }

  private async nextShared(
    _userId: string,
    model: string,
    provider: string | null,
    exclude: string[],
    excludeProviders: string[]
  ): Promise<Selection> {
    const targetProviders = provider ? [provider] : this.models.providers(model);
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
    const enabled = rows.filter((row) => !disabledSet.has(row.id) && this.canUse(row, model));
    if (enabled.length === 0) return { account: null, configured: true };
    const routing = await this.routing(model, provider === null);
    const prioritized = new Priority().order(enabled, {
      crossProvider: provider === null,
      priority: targetProviders,
      routingOptions: routing,
    });
    return { account: await this.pickHealthy(prioritized, model), configured: true };
  }

  private async eligible(
    userId: string,
    model: string,
    provider: string | null,
    exclude: string[],
    excludeProviders: string[],
    accountAccess: { mode: string; accounts: string[] }
  ): Promise<ProviderAccount[]> {
    const targetProviders = provider
      ? [provider]
      : [...new Set([...this.models.providers(model), ...(await this.customSlugs(userId, model))])];
    if (targetProviders.length === 0) return [];

    const rows: ProviderAccount[] = [];
    for (const targetProvider of targetProviders) {
      let account: ProviderAccount | null = null;
      if (this.providers.isAuthless(targetProvider)) {
        account = { id: targetProvider, userId: "", provider: targetProvider, isActive: true, status: "active" };
      } else if (this.models.isAuthless(model, targetProvider)) {
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
    const mode = accessMode(accountAccess.mode);
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
      (row) => isSyntheticProviderAccountId(row.id) || (!disabledSet.has(row.id) && this.canUse(row, model))
    );
    if (provider === null) sortAccountsByProviderPriority(enabled, targetProviders);
    return enabled;
  }

  private async customSlugs(userId: string, model: string): Promise<string[]> {
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

  private async routing(model: string, enabled: boolean): Promise<ProviderRoutingOptions | undefined> {
    if (!enabled) return undefined;
    const scores = await this.performance.scoresForModel(this.models.resolveAlias(model));
    if (scores.size === 0) return undefined;
    return this.performance.routingOptions(scores);
  }

  private async pickHealthy(
    prioritized: ProviderAccount[],
    model: string
  ): Promise<ProviderAccount | null> {
    const now = new Date();
    const lookupKeys = this.models.lookupKeys(model);
    let degraded: ProviderAccount | null = null;
    for (const account of prioritized) {
      if (isSyntheticProviderAccountId(account.id)) return account;
      const coolingDown = await this.health.refresh(account.id, now);
      if (coolingDown) continue;
      const health = await this.modelHealth.getModelHealth(account.id, this.models.resolveAlias(model));
      if (health && health.status === "degraded") {
        if (!degraded) degraded = account;
        continue;
      }
      void lookupKeys;
      this.health.bumpRequest(account.id);
      return account;
    }
    if (degraded) this.health.bumpRequest(degraded.id);
    return degraded;
  }

  private async remember(
    userId: string,
    sessionId: string,
    account: ProviderAccount
  ): Promise<void> {
    if (!sessionId || isSyntheticProviderAccountId(account.id)) return;
    if (!this.affinity.enabled(account.provider)) return;
    await this.affinity.store(userId, sessionId, account.id);
  }
}
