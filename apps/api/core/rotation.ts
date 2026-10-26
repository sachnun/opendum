import { Effect } from "effect";
import type { DatabaseFailure } from "@opendum/database";
import type { CustomPort, HealthPort, AccountPort } from "@opendum/api/core/repositories";
import { OWN_ACCOUNT_SCOPE, SHARED_ACCOUNT_SCOPE, type AccountAffinity } from "@opendum/core/redis";
import type { AuthResult, ModelValidationResult } from "@opendum/auth";
import type { ProviderAccount, ProviderRegistry } from "@opendum/providers";
import type { Registry } from "@opendum/models/runtime";
import type { Health } from "@opendum/api/core/health";
import type { ProviderPerformance, ProviderRoutingOptions } from "@opendum/api/core/provider-performance";
import { Priority, Sticky, compose } from "@opendum/api/core/routing";
import {
  accessDenial,
  isSynthetic,
  accessMode,
  normalizeIds,
  ruleRestricts,
  tierSatisfies,
  fallbackTier,
  byPriority,
} from "@opendum/api/core/service-helpers";

export type StickyMissReason = "cooldown" | "degraded" | "ineligible";

export type Selection = { account: ProviderAccount | null; configured: boolean };

export type Options = {
  accounts: AccountPort;
  modelHealth: HealthPort;
  customProviders: CustomPort;
  models: Registry;
  providers: ProviderRegistry;
  health: Health;
  performance: ProviderPerformance;
  affinity: AccountAffinity;
};

export class Rotation {
  private readonly accounts: AccountPort;
  private readonly modelHealth: HealthPort;
  private readonly customProviders: CustomPort;
  private readonly models: Registry;
  private readonly providers: ProviderRegistry;
  private readonly health: Health;
  private readonly performance: ProviderPerformance;
  private readonly affinity: AccountAffinity;

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

  nextAccount(
    authResult: AuthResult,
    validation: ModelValidationResult,
    tried: string[],
    sharedTried: string[],
    excludedProviders: string[],
    useShared: boolean
  ): Effect.Effect<Selection, DatabaseFailure> {
    if (useShared) {
      return this.nextShared(
        authResult.userId,
        validation.model,
        validation.provider,
        sharedTried,
        excludedProviders
      );
    }
    return this.nextAvailable(
      authResult.userId,
      validation.model,
      validation.provider,
      tried,
      excludedProviders,
      { mode: authResult.accountAccessMode, accounts: authResult.accountAccessList }
    );
  }

  canUse(account: ProviderAccount, model: string): boolean {
    const rule = this.models.rule(model, account.provider);
    if (!rule || !ruleRestricts(rule.minTier, rule.allowedTiers)) return true;
    const tier = account.tier ?? fallbackTier(account);
    return tierSatisfies(tier, rule.minTier, rule.allowedTiers);
  }

  private nextAvailable(
    userId: string,
    model: string,
    provider: string | null,
    exclude: string[],
    excludeProviders: string[],
    accountAccess: { mode: string; accounts: string[] }
  ): Effect.Effect<Selection, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      const eligible = yield* this.eligible(userId, model, provider, exclude, excludeProviders, accountAccess);
      if (eligible.length === 0) return { account: null, configured: false };
      const routing = yield* this.routing(model, provider === null);
      const stickyId = yield* this.affinity.lookup(userId, OWN_ACCOUNT_SCOPE);
      const strategy = compose(new Priority(), new Sticky(stickyId));
      const prioritized = strategy.order(eligible, {
        crossProvider: provider === null,
        priority: this.models.providers(model),
        routingOptions: routing,
      });
      const selected = yield* this.pickHealthy(prioritized, model, stickyId);
      if (!selected) return { account: null, configured: true };
      yield* this.remember(userId, selected, OWN_ACCOUNT_SCOPE);
      return { account: selected, configured: true };
    });
  }

  private nextShared(
    userId: string,
    model: string,
    provider: string | null,
    exclude: string[],
    excludeProviders: string[]
  ): Effect.Effect<Selection, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      const targetProviders = provider ? [provider] : this.models.providers(model);
      if (targetProviders.length === 0) return { account: null, configured: false };
      const now = new Date();
      const sharedRows = yield* this.accounts.sharedAccounts({
        userId,
        providers: targetProviders,
        now,
        excludeIds: exclude,
        excludeProviders,
      });
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
      const disabled = yield* this.accounts.disabledIds({
        accountIds: ids,
        models: lookupKeys,
      });
      const disabledSet = new Set(disabled.map((row) => row.providerAccountId));
      const enabled = rows.filter((row) => !disabledSet.has(row.id) && this.canUse(row, model));
      if (enabled.length === 0) return { account: null, configured: true };
      const routing = yield* this.routing(model, provider === null);
      const stickyId = yield* this.affinity.lookup(userId, SHARED_ACCOUNT_SCOPE);
      const strategy = compose(new Priority(), new Sticky(stickyId));
      const prioritized = strategy.order(enabled, {
        crossProvider: provider === null,
        priority: targetProviders,
        routingOptions: routing,
      });
      const account = yield* this.pickHealthy(prioritized, model, stickyId);
      if (!account) return { account: null, configured: true };
      yield* this.remember(userId, account, SHARED_ACCOUNT_SCOPE);
      return { account, configured: true };
    });
  }

  private eligible(
    userId: string,
    model: string,
    provider: string | null,
    exclude: string[],
    excludeProviders: string[],
    accountAccess: { mode: string; accounts: string[] }
  ): Effect.Effect<ProviderAccount[], DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      const slugs = provider ? [] : (yield* this.customSlugs(userId, model));
      const targetProviders = provider
        ? [provider]
        : [...new Set([...this.models.providers(model), ...slugs])];
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
        if (accessDenial(account.id, accountAccess)) continue;
        rows.push(account);
      }

      const now = new Date();
      const mode = accessMode(accountAccess.mode);
      const accounts = normalizeIds(accountAccess.accounts);
      const dbRows = yield* this.accounts.listEligibleAccounts({
        userId,
        providers: targetProviders,
        now,
        excludeIds: exclude,
        excludeProviders,
        useWhitelist: mode === "whitelist" && accounts.length > 0,
        accountIds: accounts,
        useBlacklist: mode === "blacklist" && accounts.length > 0,
      });
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
      const disabled = yield* this.accounts.disabledIds({
        accountIds: ids,
        models: lookupKeys,
      });
      const disabledSet = new Set(disabled.map((row) => row.providerAccountId));
      const enabled = rows.filter(
        (row) => isSynthetic(row.id) || (!disabledSet.has(row.id) && this.canUse(row, model))
      );
      if (provider === null) byPriority(enabled, targetProviders);
      return enabled;
    });
  }

  private customSlugs(userId: string, model: string): Effect.Effect<string[], DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      const providers = yield* this.customProviders.listCustomProviders(userId);
      if (providers.length === 0) return [];
      const canonical = this.models.resolveAlias(model);
      const results = yield* Effect.forEach(
        providers,
        (custom) =>
          this.customProviders.customModels(custom.id).pipe(
            Effect.map((rows) =>
              rows.some((row) => row.aliased && this.models.resolveAlias(row.modelId) === canonical)
                ? custom.slug
                : null
            )
          ),
        { concurrency: 4 }
      );
      return results.filter((slug): slug is string => slug !== null);
    });
  }

  private routing(model: string, enabled: boolean): Effect.Effect<ProviderRoutingOptions | undefined> {
    if (!enabled) return Effect.succeed(undefined);
    return Effect.gen({ self: this }, function* () {
      const scores = yield* this.performance.scoresForModel(this.models.resolveAlias(model));
      if (scores.size === 0) return undefined;
      return this.performance.routingOptions(scores);
    });
  }

  private pickHealthy(
    prioritized: ProviderAccount[],
    model: string,
    stickyId: string
  ): Effect.Effect<ProviderAccount | null, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      const now = new Date();
      let degraded: ProviderAccount | null = null;
      let stickyMiss: StickyMissReason | null = null;
      for (const account of prioritized) {
        if (isSynthetic(account.id)) return account;
        const coolingDown = yield* this.health.refresh(account.id, now);
        if (coolingDown) {
          if (account.id === stickyId) stickyMiss = "cooldown";
          continue;
        }
        const health = yield* this.modelHealth.getModelHealth(
          account.id,
          this.models.resolveAlias(model)
        );
        if (health && health.status === "degraded") {
          if (account.id === stickyId) stickyMiss = "degraded";
          if (!degraded) degraded = account;
          continue;
        }
        this.health.bumpRequest(account.id);
        if (stickyId && account.id !== stickyId) {
          yield* Rotation.logStickyMiss(stickyId, stickyMiss ?? "ineligible", account.id);
        }
        return account;
      }
      if (degraded) this.health.bumpRequest(degraded.id);
      return degraded;
    });
  }

  private static logStickyMiss(
    stickyId: string,
    reason: StickyMissReason,
    selectedId: string
  ): Effect.Effect<void> {
    return Effect.logDebug("account affinity miss", { stickyId, reason, selectedId });
  }

  private remember(userId: string, account: ProviderAccount, scope: string): Effect.Effect<void> {
    if (isSynthetic(account.id)) return Effect.void;
    if (!this.affinity.enabled(account.provider)) return Effect.void;
    return this.affinity.store(userId, account.id, scope);
  }
}
