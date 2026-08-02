import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { ProxyDB, ProviderAccount, ProviderAccountModelHealth } from "../db/index.js";
import { schema } from "../db/index.js";
import { newID } from "../db/id.js";
import type { Registry } from "../registry/index.js";
import type { AccountAccess, ModelValidationResult } from "../auth/types.js";
import { normalizeAccessMode, normalizeAccountList } from "../auth/service.js";
import type { Affinity } from "../session/index.js";
import { preferSticky } from "../session/index.js";
import { isAuthlessProvider } from "../auth/authless-providers.js";
import { isSyntheticProviderAccountID, providerModelAuthlessAccountPrefix } from "./load-balancer-helpers.js";
import { upsertErrorHistory } from "./error-history.js";
import type { RouteError } from "./types.js";

export const failedCooldownMS = 10 * 60 * 1000;
export const unhealthyIdleDecayIntervalMS = 10 * 60 * 1000;
export const modelDegradedThreshold = 2;
export const accountCooldownUnhealthyThreshold = 10;
export const cooldownRecoveryRatio = 0.3;
export const maxStoredErrorLen = 10000;

export function syntheticAuthlessAccount(provider: string): ProviderAccount | null {
  if (!isAuthlessProvider(provider)) return null;
  return { id: provider, userId: "", provider, name: provider, accessToken: "", refreshToken: "", expiresAt: new Date(), apiKey: null, projectId: null, tier: null, accountId: null, email: null, isActive: true, disabledUntil: null, lastUsedAt: null, status: "active" } as ProviderAccount;
}

export function syntheticProviderModelAuthlessAccount(provider: string): ProviderAccount {
  return { id: providerModelAuthlessAccountPrefix + provider, userId: "", provider, name: provider, accessToken: "", refreshToken: "", expiresAt: new Date(), apiKey: null, projectId: null, tier: null, accountId: null, email: null, isActive: true, disabledUntil: null, lastUsedAt: null, status: "active" } as ProviderAccount;
}

export interface LoadBalancerDeps {
  db: ProxyDB | null;
  registry: Registry;
  affinity: Affinity | null;
  upsertErrorHistory: (accountID: string, userID: string, model: string | null, statusCode: number, message: string, createdAt: Date) => Promise<void>;
}

export class LoadBalancer {
  constructor(private deps: LoadBalancerDeps) {}

  private get db(): ProxyDB | null {
    return this.deps.db;
  }

  private get registry(): Registry {
    return this.deps.registry;
  }

  private get affinity(): Affinity | null {
    return this.deps.affinity;
  }

  async getEligibleAccounts(userID: string, model: string, provider: string | null, exclude: string[], excludeProviders: string[], accountAccess: AccountAccess): Promise<ProviderAccount[]> {
    let targetProviders: string[] = [];
    if (provider !== null) {
      targetProviders = [provider];
    } else {
      targetProviders = this.registry.providersForModel(model);
    }
    if (targetProviders.length === 0) return [];

    const rows: ProviderAccount[] = [];
    for (const targetProvider of targetProviders) {
      let account = syntheticAuthlessAccount(targetProvider);
      if (!account && this.registry.isAuthlessProviderModel(model, targetProvider)) {
        account = syntheticProviderModelAuthlessAccount(targetProvider);
      }
      if (!account) continue;
      if (exclude.length > 0 && exclude.includes(account.id)) continue;
      if (excludeProviders.length > 0 && excludeProviders.includes(account.provider)) continue;
      if (accountAccessDenial(account.id, accountAccess)[2]) continue;
      rows.push(account);
    }

    if (!this.db) return rows;

    const now = new Date();
    const conditions = [
      eq(schema.providerAccount.userId, userID),
      inArray(schema.providerAccount.provider, targetProviders),
      eq(schema.providerAccount.isActive, true),
      or(isNull(schema.providerAccount.disabledUntil), sql`${schema.providerAccount.disabledUntil} <= ${now}`),
    ];
    if (exclude.length > 0) conditions.push(notInArray(schema.providerAccount.id, exclude));
    if (excludeProviders.length > 0) conditions.push(notInArray(schema.providerAccount.provider, excludeProviders));
    const accountMode = normalizeAccessMode(accountAccess.mode);
    const accounts = normalizeAccountList(accountAccess.accounts);
    if (accountMode === "whitelist" && accounts.length > 0) conditions.push(inArray(schema.providerAccount.id, accounts));
    if (accountMode === "blacklist" && accounts.length > 0) conditions.push(notInArray(schema.providerAccount.id, accounts));

    const dbRows = await this.db
      .select({
        id: schema.providerAccount.id,
        userId: schema.providerAccount.userId,
        provider: schema.providerAccount.provider,
        tier: schema.providerAccount.tier,
        status: schema.providerAccount.status,
        lastUsedAt: schema.providerAccount.lastUsedAt,
        createdAt: schema.providerAccount.createdAt,
        accountId: schema.providerAccount.accountId,
        disabledUntil: schema.providerAccount.disabledUntil,
        isActive: schema.providerAccount.isActive,
      })
      .from(schema.providerAccount)
      .where(and(...conditions))
      .orderBy(sql`status ASC`, sql`"lastUsedAt" ASC NULLS FIRST`, sql`"createdAt" ASC`);
    rows.push(...dbRows.map((r) => ({ ...r, name: r.provider, accessToken: "", refreshToken: "", expiresAt: new Date(), apiKey: null, projectId: null, email: null }) as ProviderAccount));
    if (rows.length === 0) return rows;

    const lookupKeys = this.registry.lookupKeys(model);
    const ids = rows.map((row) => row.id);
    const disabledRows = await this.db
      .select({ providerAccountId: schema.providerAccountDisabledModel.providerAccountId })
      .from(schema.providerAccountDisabledModel)
      .where(and(inArray(schema.providerAccountDisabledModel.providerAccountId, ids), inArray(schema.providerAccountDisabledModel.model, lookupKeys)));
    const disabledSet = new Set(disabledRows.map((row) => row.providerAccountId));

    const enabled: ProviderAccount[] = [];
    for (const row of rows) {
      if (isSyntheticProviderAccountID(row.id)) {
        enabled.push(row);
        continue;
      }
      if (!disabledSet.has(row.id) && this.canAccountUseModel(row, model)) {
        enabled.push(row);
      }
    }
    if (provider === null) {
      sortAccountsByProviderPriority(enabled, targetProviders);
    }
    return enabled;
  }

  async getNextAvailableAccount(userID: string, model: string, provider: string | null, exclude: string[], excludeProviders: string[], accountAccess: AccountAccess, sessionID: string): Promise<[ProviderAccount | null, boolean, Error | null]> {
    const eligible = await this.getEligibleAccounts(userID, model, provider, exclude, excludeProviders, accountAccess);
    if (eligible.length === 0) return [null, false, null];
    let prioritized = prioritizeAccounts(eligible, provider === null, this.registry.providersForModel(model));
    if (this.affinity) {
      const stickyID = await this.affinity.lookup(userID, sessionID);
      if (stickyID !== "") {
        prioritized = preferSticky(prioritized, (a) => a.id === stickyID);
      }
    }
    const [selected, has, err] = await this.pickHealthyAccount(prioritized, model);
    if (err) return [null, false, err];
    if (!has) return [null, false, null];
    if (selected && this.affinity && this.affinity.enabled(selected.provider) && sessionID !== "") {
      await this.affinity.store(userID, sessionID, selected.id);
    }
    return [selected, has, null];
  }

  async getNextSharedAccount(userID: string, model: string, provider: string | null, exclude: string[], excludeProviders: string[]): Promise<[ProviderAccount | null, boolean, Error | null]> {
    let targetProviders: string[] = [];
    if (provider !== null) {
      targetProviders = [provider];
    } else {
      targetProviders = this.registry.providersForModel(model);
    }
    if (targetProviders.length === 0 || !this.db) return [null, false, null];

    const now = new Date();
    const conditions = [
      sql`${schema.providerAccount.userId} != ${userID}`,
      eq(schema.userSharingSetting.enabled, true),
      inArray(schema.providerAccount.provider, targetProviders),
      eq(schema.providerAccount.isActive, true),
      or(isNull(schema.providerAccount.disabledUntil), sql`${schema.providerAccount.disabledUntil} <= ${now}`),
    ];
    if (exclude.length > 0) conditions.push(notInArray(schema.providerAccount.id, exclude));
    if (excludeProviders.length > 0) conditions.push(notInArray(schema.providerAccount.provider, excludeProviders));

    let rows = (await this.db
      .select({
        id: schema.providerAccount.id,
        userId: schema.providerAccount.userId,
        provider: schema.providerAccount.provider,
        tier: schema.providerAccount.tier,
        status: schema.providerAccount.status,
        lastUsedAt: schema.providerAccount.lastUsedAt,
        createdAt: schema.providerAccount.createdAt,
        accountId: schema.providerAccount.accountId,
        disabledUntil: schema.providerAccount.disabledUntil,
        isActive: schema.providerAccount.isActive,
      })
      .from(schema.providerAccount)
      .innerJoin(schema.userSharingSetting, eq(schema.userSharingSetting.userId, schema.providerAccount.userId))
      .where(and(...conditions))
      .orderBy(sql`status ASC`, sql`"lastUsedAt" ASC NULLS FIRST`, sql`"createdAt" ASC`)) as unknown as ProviderAccount[];
    if (rows.length === 0) return [null, false, null];
    rows = rows.map((r) => ({ ...r, name: r.provider, accessToken: "", refreshToken: "", expiresAt: new Date(), apiKey: null, projectId: null, email: null }));

    const lookupKeys = this.registry.lookupKeys(model);
    const ids = rows.map((row) => row.id);
    const disabledRows = await this.db
      .select({ providerAccountId: schema.providerAccountDisabledModel.providerAccountId })
      .from(schema.providerAccountDisabledModel)
      .where(and(inArray(schema.providerAccountDisabledModel.providerAccountId, ids), inArray(schema.providerAccountDisabledModel.model, lookupKeys)));
    const disabledSet = new Set(disabledRows.map((row) => row.providerAccountId));

    const enabled: ProviderAccount[] = [];
    for (const row of rows) {
      if (!disabledSet.has(row.id) && this.canAccountUseModel(row, model)) {
        enabled.push(row);
      }
    }
    if (enabled.length === 0) return [null, true, null];
    const prioritized = prioritizeAccounts(enabled, provider === null, targetProviders);
    return this.pickHealthyAccount(prioritized, model);
  }

  async pickHealthyAccount(prioritized: ProviderAccount[], model: string): Promise<[ProviderAccount | null, boolean, Error | null]> {
    if (!this.db) {
      return [prioritized[0] ?? null, prioritized.length > 0, null];
    }
    const now = new Date();
    const ready: ProviderAccount[] = [];
    for (const account of prioritized) {
      if (isSyntheticProviderAccountID(account.id)) {
        ready.push(account);
        continue;
      }
      const [coolingDown, err] = await this.refreshAccountHealthFromModels(account.id, now);
      if (err) return [null, true, err];
      if (coolingDown) continue;
      ready.push(account);
    }
    if (ready.length === 0) return [null, true, null];

    const ids = ready.map((a) => a.id);
    const health = await this.getHealthByAccount(ids, this.registry.lookupKeys(model));

    let selected: ProviderAccount | null = null;
    for (const account of ready) {
      const row = health.get(account.id);
      if (row) {
        if (row.status === "degraded") {
          if (selected === null) selected = account;
          continue;
        }
      }
      selected = account;
      break;
    }
    if (selected === null) return [null, true, null];
    void this.bumpAccountRequestCount(selected.id, now);
    return [selected, true, null];
  }

  async bumpAccountRequestCount(accountID: string, usedAt: Date): Promise<void> {
    if (isSyntheticProviderAccountID(accountID) || !this.db) return;
    await this.db.update(schema.providerAccount).set({ lastUsedAt: usedAt, requestCount: sql`${schema.providerAccount.requestCount} + 1` }).where(eq(schema.providerAccount.id, accountID)).catch(() => undefined);
  }

  async getHealthByAccount(accountIDs: string[], modelKeys: string[]): Promise<Map<string, ProviderAccountModelHealth>> {
    const result = new Map<string, ProviderAccountModelHealth>();
    if (accountIDs.length === 0 || modelKeys.length === 0 || !this.db) return result;
    const rows = await this.db
      .select()
      .from(schema.providerAccountModelHealth)
      .where(and(inArray(schema.providerAccountModelHealth.providerAccountId, accountIDs), inArray(schema.providerAccountModelHealth.model, modelKeys)));
    for (const row of rows) {
      result.set(row.providerAccountId, row as ProviderAccountModelHealth);
    }
    return result;
  }

  async normalizeModelHealthRows(rows: ProviderAccountModelHealth[], now: Date, applyCooldownRecovery: boolean): Promise<[number, Error | null]> {
    if (!this.db) return [0, null];
    let total = 0;
    for (const row of rows) {
      let count = effectiveUnhealthyCount(row, now);
      if (applyCooldownRecovery) {
        count = cooldownRecoveryCount(count);
      }
      const status = modelHealthStatus(count);
      const statusChanged = status !== row.status;
      total += count;

      if (count === row.consecutiveErrors && !statusChanged && !applyCooldownRecovery) continue;
      const patch: Partial<ProviderAccountModelHealth> = { consecutiveErrors: count, unhealthyCountUpdatedAt: now };
      if (row.status === "failed" || statusChanged) {
        patch.status = status;
        patch.statusChangedAt = now;
      }
      await this.db.update(schema.providerAccountModelHealth).set(patch as never).where(eq(schema.providerAccountModelHealth.id, row.id)).catch(() => undefined);
    }
    return [total, null];
  }

  async refreshAccountHealthFromModels(accountID: string, now: Date): Promise<[boolean, Error | null]> {
    if (isSyntheticProviderAccountID(accountID) || !this.db) return [false, null];

    const accountRows = await this.db
      .select({ id: schema.providerAccount.id, status: schema.providerAccount.status, disabledUntil: schema.providerAccount.disabledUntil, consecutiveErrors: schema.providerAccount.consecutiveErrors })
      .from(schema.providerAccount)
      .where(eq(schema.providerAccount.id, accountID))
      .limit(1);
    if (accountRows.length === 0) return [false, null];
    const account = accountRows[0]!;

    const rows = await this.db.select().from(schema.providerAccountModelHealth).where(eq(schema.providerAccountModelHealth.providerAccountId, accountID));
    const applyCooldownRecovery = account.status === "failed" && account.disabledUntil !== null && account.disabledUntil.getTime() <= now.getTime();
    const [total, err] = await this.normalizeModelHealthRows(rows as ProviderAccountModelHealth[], now, applyCooldownRecovery);
    if (err) return [false, err];

    if (account.disabledUntil !== null && account.disabledUntil.getTime() > now.getTime()) {
      if (account.consecutiveErrors !== total) {
        await this.db.update(schema.providerAccount).set({ consecutiveErrors: total, status: "failed", statusChangedAt: now }).where(eq(schema.providerAccount.id, accountID));
      }
      return [true, null];
    }

    if (total >= accountCooldownUnhealthyThreshold) {
      const cooldownUntil = failedCooldownUntil(now);
      await this.db.update(schema.providerAccount).set({ status: "failed", statusChangedAt: now, consecutiveErrors: total, disabledUntil: cooldownUntil }).where(eq(schema.providerAccount.id, accountID));
      return [true, null];
    }

    if (account.status !== "active" || (account.disabledUntil !== null && account.disabledUntil.getTime() <= now.getTime()) || account.consecutiveErrors !== total) {
      await this.db.update(schema.providerAccount).set({ status: "active", statusChangedAt: now, consecutiveErrors: total, disabledUntil: null }).where(eq(schema.providerAccount.id, accountID));
    }
    return [false, null];
  }

  async validateForcedAccount(userID: string, validation: ModelValidationResult, forcedAccountID: string | null, accountAccess: AccountAccess, allowInactive: boolean): Promise<[ProviderAccount | null, RouteError | null]> {
    if (forcedAccountID === null || forcedAccountID === undefined) return [null, null];
    const id = forcedAccountID.trim();
    const param = "model";
    if (id === "") {
      return [null, routeError(400, "model account selector must include an account prefix", "invalid_request_error", param, "invalid_provider_account")];
    }
    const synthetic = syntheticAuthlessAccount(id);
    if (synthetic) {
      const [message, code, denied] = accountAccessDenial(synthetic.id, accountAccess);
      if (denied) return [null, routeError(403, message, "invalid_request_error", param, code)];
      const modelErr = this.validateSelectedAccountModel(synthetic, validation, param);
      if (modelErr) return [null, modelErr];
      return [synthetic, null];
    }
    if (id.startsWith(providerModelAuthlessAccountPrefix)) {
      const provider = id.slice(providerModelAuthlessAccountPrefix.length);
      if (provider !== id && provider !== "" && this.registry.isAuthlessProviderModel(validation.model, provider)) {
        const account = syntheticProviderModelAuthlessAccount(provider);
        const [message, code, denied] = accountAccessDenial(account.id, accountAccess);
        if (denied) return [null, routeError(403, message, "invalid_request_error", param, code)];
        const modelErr = this.validateSelectedAccountModel(account, validation, param);
        if (modelErr) return [null, modelErr];
        return [account, null];
      }
    }
    if (!this.db) return [null, routeError(500, "Internal server error", "api_error", "", "")];
    const accountRows = await this.db
      .select({
        id: schema.providerAccount.id,
        userId: schema.providerAccount.userId,
        provider: schema.providerAccount.provider,
        tier: schema.providerAccount.tier,
        status: schema.providerAccount.status,
        lastUsedAt: schema.providerAccount.lastUsedAt,
        createdAt: schema.providerAccount.createdAt,
        accountId: schema.providerAccount.accountId,
        isActive: schema.providerAccount.isActive,
        disabledUntil: schema.providerAccount.disabledUntil,
      })
      .from(schema.providerAccount)
      .where(and(eq(schema.providerAccount.id, id), eq(schema.providerAccount.userId, userID)))
      .limit(1);
    if (accountRows.length === 0) {
      return [null, routeError(400, "Selected provider account was not found", "invalid_request_error", param, "provider_account_not_found")];
    }
    const account = accountRows[0] as ProviderAccount;
    const [coolingDown, err] = await this.refreshAccountHealthFromModels(account.id, new Date());
    if (err) return [null, routeError(500, "Internal server error", "api_error", "", "")];
    if (coolingDown) {
      return [null, routeError(400, "Selected provider account is temporarily disabled", "invalid_request_error", param, "provider_account_temporarily_disabled")];
    }
    const availabilityErr = validateForcedAccountAvailability(account, allowInactive, param);
    if (availabilityErr) return [null, availabilityErr];
    const [message, code, denied] = accountAccessDenial(account.id, accountAccess);
    if (denied) return [null, routeError(403, message, "invalid_request_error", param, code)];
    const modelErr = this.validateSelectedAccountModel(account, validation, param);
    if (modelErr) return [null, modelErr];
    return [account, null];
  }

  validateSelectedAccountModel(account: ProviderAccount, validation: ModelValidationResult, param: string): RouteError | null {
    if (!this.registry.isSupportedByProvider(validation.model, account.provider)) {
      return routeError(400, `Selected account provider "${account.provider}" does not support model "${validation.model}"`, "invalid_request_error", param, "provider_account_model_mismatch");
    }
    if (validation.provider !== null && account.provider !== validation.provider) {
      return routeError(400, `Selected account provider "${account.provider}" does not match model provider "${validation.provider}"`, "invalid_request_error", param, "provider_account_provider_mismatch");
    }
    if (!this.canAccountUseModel(account, validation.model)) {
      return routeError(400, `Selected provider account tier does not allow model "${validation.model}"`, "invalid_request_error", param, "provider_account_tier_mismatch");
    }
    return null;
  }

  canAccountUseModel(account: ProviderAccount, model: string): boolean {
    if (!this.registry) return true;
    const rule = this.registry.providerAccessRule(model, account.provider);
    if (!rule || !accountAccessRuleRestrictsTier(rule.minTier, rule.allowedTiers)) return true;
    return accountTierSatisfiesRule(quotaFallbackTier(account), rule.minTier, rule.allowedTiers);
  }

  async markAccountSuccess(accountID: string, model: string): Promise<void> {
    if (isSyntheticProviderAccountID(accountID) || !this.db) return;
    const now = new Date();
    await this.db.update(schema.providerAccount).set({ successCount: sql`${schema.providerAccount.successCount} + 1`, lastSuccessAt: now }).where(eq(schema.providerAccount.id, accountID)).catch(() => undefined);
    const resolved = this.registry.resolveAlias(model);
    const healthRows = await this.db
      .select()
      .from(schema.providerAccountModelHealth)
      .where(and(eq(schema.providerAccountModelHealth.providerAccountId, accountID), eq(schema.providerAccountModelHealth.model, resolved)))
      .limit(1);
    if (healthRows.length === 0) {
      await this.refreshAccountHealthFromModels(accountID, now);
      return;
    }
    const health = healthRows[0] as ProviderAccountModelHealth;
    const nextErrors = successRecoveryCount(health, now);
    const nextStatus = modelHealthStatus(nextErrors);
    const patch: Partial<ProviderAccountModelHealth> = { consecutiveErrors: nextErrors, lastSuccessAt: now, unhealthyCountUpdatedAt: now };
    if (nextStatus !== health.status) {
      patch.status = nextStatus;
      patch.statusChangedAt = now;
    }
    await this.db.update(schema.providerAccountModelHealth).set(patch as never).where(eq(schema.providerAccountModelHealth.id, health.id)).catch(() => undefined);
    await this.refreshAccountHealthFromModels(accountID, now);
  }

  async markAccountFailed(accountID: string, model: string, statusCode: number, message: string): Promise<Date> {
    const now = new Date();
    if (isSyntheticProviderAccountID(accountID)) return now;
    if (!this.db) return now;
    if (message.length > maxStoredErrorLen) message = message.slice(0, maxStoredErrorLen);
    await this.db.update(schema.providerAccount).set({ errorCount: sql`${schema.providerAccount.errorCount} + 1`, lastErrorAt: now, lastErrorCode: statusCode }).where(eq(schema.providerAccount.id, accountID)).catch(() => undefined);
    const resolved = this.registry.resolveAlias(model);
    const healthRows = await this.db
      .select()
      .from(schema.providerAccountModelHealth)
      .where(and(eq(schema.providerAccountModelHealth.providerAccountId, accountID), eq(schema.providerAccountModelHealth.model, resolved)))
      .limit(1);
    if (healthRows.length > 0) {
      const health = healthRows[0] as ProviderAccountModelHealth;
      const nextErrors = effectiveUnhealthyCount(health, now) + 1;
      const nextStatus = modelHealthStatus(nextErrors);
      const patch: Partial<ProviderAccountModelHealth> = { consecutiveErrors: nextErrors, lastErrorAt: now, lastErrorCode: statusCode, unhealthyCountUpdatedAt: now };
      if (nextStatus !== health.status) {
        patch.status = nextStatus;
        patch.statusChangedAt = now;
      }
      await this.db.update(schema.providerAccountModelHealth).set(patch as never).where(eq(schema.providerAccountModelHealth.id, health.id)).catch(() => undefined);
    } else {
      const nextErrors = 1;
      const nextStatus = modelHealthStatus(nextErrors);
      await this.db.insert(schema.providerAccountModelHealth).values({ id: newID(), providerAccountId: accountID, model: resolved, consecutiveErrors: nextErrors, status: nextStatus, lastErrorAt: now, lastErrorCode: statusCode, unhealthyCountUpdatedAt: now, createdAt: now, updatedAt: now }).catch(() => undefined);
    }
    await this.refreshAccountHealthFromModels(accountID, now);

    const userRows = await this.db.select({ userId: schema.providerAccount.userId }).from(schema.providerAccount).where(eq(schema.providerAccount.id, accountID)).limit(1);
    if (userRows.length > 0) {
      await this.deps.upsertErrorHistory(accountID, userRows[0]!.userId, resolved, statusCode, message, now);
    }
    return now;
  }

  async markAccountUsageLimited(accountID: string, model: string, disabledUntil: Date, failedAt: Date): Promise<void> {
    if (isSyntheticProviderAccountID(accountID) || !this.db) return;
    const resolved = this.registry.resolveAlias(model);
    await this.db.update(schema.providerAccountModelHealth).set({ status: "failed", statusChangedAt: failedAt, consecutiveErrors: accountCooldownUnhealthyThreshold, lastErrorAt: failedAt, unhealthyCountUpdatedAt: failedAt }).where(and(eq(schema.providerAccountModelHealth.providerAccountId, accountID), eq(schema.providerAccountModelHealth.model, resolved))).catch(() => undefined);
    await this.refreshAccountHealthFromModels(accountID, failedAt);
    await this.db.update(schema.providerAccount).set({ disabledUntil, status: "failed", statusChangedAt: failedAt }).where(eq(schema.providerAccount.id, accountID)).catch(() => undefined);
  }

  async markAccountsRecoveredByRotation(failures: Array<{ accountId: string; failedAt: Date }>): Promise<void> {
    if (!this.db) return;
    const latest = new Map<string, Date>();
    for (const failure of failures) {
      const existing = latest.get(failure.accountId);
      if (!existing || failure.failedAt.getTime() > existing.getTime()) {
        latest.set(failure.accountId, failure.failedAt);
      }
    }
    if (latest.size === 0) return;
    const recoveredAt = new Date();
    for (const [accountID, failedAt] of latest) {
      if (isSyntheticProviderAccountID(accountID)) continue;
      await this.db.update(schema.providerAccount).set({ lastRecoveredByRotationAt: recoveredAt }).where(and(eq(schema.providerAccount.id, accountID), sql`${schema.providerAccount.lastErrorAt} <= ${failedAt}`)).catch(() => undefined);
    }
  }
}

export function effectiveUnhealthyCount(row: ProviderAccountModelHealth, now: Date): number {
  let count = row.consecutiveErrors;
  if (count <= 0) return 0;
  const lastRequestAt = latestHealthRequestAt(row);
  if (!lastRequestAt || lastRequestAt.getTime() > now.getTime()) return count;
  const decay = Math.floor((now.getTime() - lastRequestAt.getTime()) / unhealthyIdleDecayIntervalMS);
  if (decay <= 0) return count;
  if (decay >= count) return 0;
  return count - decay;
}

export function latestHealthRequestAt(row: ProviderAccountModelHealth): Date | null {
  let latest: Date | null = row.unhealthyCountUpdatedAt;
  if (row.lastErrorAt !== null && (latest === null || row.lastErrorAt.getTime() > latest.getTime())) latest = row.lastErrorAt;
  if (row.lastSuccessAt !== null && (latest === null || row.lastSuccessAt.getTime() > latest.getTime())) latest = row.lastSuccessAt;
  if (latest === null && row.updatedAt) latest = row.updatedAt;
  if (latest === null && row.createdAt) latest = row.createdAt;
  return latest;
}

export function modelHealthStatus(unhealthyCount: number): string {
  return unhealthyCount >= modelDegradedThreshold ? "degraded" : "active";
}

export function cooldownRecoveryCount(unhealthyCount: number): number {
  if (unhealthyCount <= 0) return 0;
  const reduction = Math.round(unhealthyCount * cooldownRecoveryRatio);
  if (reduction < 0) reduction;
  if (reduction > unhealthyCount) return 0;
  return unhealthyCount - reduction;
}

export function isImmediatelyRecoverableStatusCode(code: number): boolean {
  return code === 408 || code === 429 || code >= 500;
}

export function successRecoveryCount(row: ProviderAccountModelHealth, now: Date): number {
  let count = effectiveUnhealthyCount(row, now);
  if (row.lastErrorCode !== null && !isImmediatelyRecoverableStatusCode(row.lastErrorCode)) {
    return count;
  }
  if (count > 0) count--;
  return count;
}

export function failedCooldownUntil(failedAt: Date): Date {
  return new Date(failedAt.getTime() + failedCooldownMS);
}

export function sortAccountsByProviderPriority(accounts: ProviderAccount[], priority: string[]): void {
  const order = new Map<string, number>();
  priority.forEach((p, i) => order.set(p, i));
  accounts.sort((a, b) => {
    const ai = order.get(a.provider) ?? 1 << 30;
    const aj = order.get(b.provider) ?? 1 << 30;
    if (ai !== aj) return ai - aj;
    if (a.status !== b.status) return a.status < b.status ? -1 : 1;
    return nullableTimeBefore(a.lastUsedAt, b.lastUsedAt) ? -1 : 1;
  });
}

export function prioritizeAccounts(accounts: ProviderAccount[], groupByProvider: boolean, priority: string[]): ProviderAccount[] {
  if (!groupByProvider) return paidFirst(accounts);
  const byProvider = new Map<string, ProviderAccount[]>();
  for (const account of accounts) {
    const list = byProvider.get(account.provider) ?? [];
    list.push(account);
    byProvider.set(account.provider, list);
  }
  const result: ProviderAccount[] = [];
  for (const provider of priority) {
    result.push(...paidFirst(byProvider.get(provider) ?? []));
  }
  return result;
}

export function paidFirst(accounts: ProviderAccount[]): ProviderAccount[] {
  const paid: ProviderAccount[] = [];
  const free: ProviderAccount[] = [];
  for (const account of accounts) {
    if (isSyntheticProviderAccountID(account.id)) {
      free.push(account);
    } else if (isPaidAccountTier(account.provider, account.tier)) {
      paid.push(account);
    } else {
      free.push(account);
    }
  }
  return [...paid, ...free];
}

export function isPaidAccountTier(provider: string, tier: string | null): boolean {
  if (tier === null) return false;
  const value = tier.trim().toLowerCase();
  switch (provider) {
    case "antigravity":
      return value === "paid" || value === "standard-tier";
    case "kiro":
      return value === "pro" || value === "pro+" || value === "pro-plus" || value === "power";
  }
  switch (value) {
    case "paid":
    case "standard-tier":
    case "plus":
    case "pro":
    case "pro-plus":
    case "pro+":
    case "prolite":
    case "power":
    case "team":
    case "go":
    case "self_serve_business_usage_based":
    case "business":
    case "enterprise_cbp_usage_based":
    case "enterprise":
    case "edu":
    case "education":
    case "hc":
      return true;
    default:
      return false;
  }
}

function nullableTimeBefore(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return false;
  if (a === null) return true;
  if (b === null) return false;
  return a.getTime() < b.getTime();
}

export function accountAccessDenial(accountID: string, access: AccountAccess): [string, string, boolean] {
  const mode = normalizeAccessMode(access.mode);
  const set = new Set(normalizeAccountList(access.accounts));
  if (mode === "whitelist") {
    if (!set.has(accountID)) {
      return ["Selected provider account is not allowed for this API key.", "provider_account_not_whitelisted", true];
    }
  }
  if (mode === "blacklist") {
    if (set.has(accountID)) {
      return ["Selected provider account is blocked for this API key.", "provider_account_blacklisted", true];
    }
  }
  return ["", "", false];
}

function validateForcedAccountAvailability(account: ProviderAccount, allowInactive: boolean, param: string): RouteError | null {
  if (allowInactive) return null;
  if (!account.isActive) {
    return routeError(400, "Selected provider account is inactive", "invalid_request_error", param, "provider_account_inactive");
  }
  if (account.disabledUntil !== null && account.disabledUntil.getTime() > Date.now()) {
    return routeError(400, "Selected provider account is temporarily disabled", "invalid_request_error", param, "provider_account_temporarily_disabled");
  }
  return null;
}

export function accountTierSatisfiesRule(accountTier: string, minTier: string, allowedTiers: string[]): boolean {
  const normalizedAccountTier = normalizeAccountTierAlias(accountTier);
  if (allowedTiers.length > 0) {
    for (const tier of allowedTiers) {
      if (normalizeAccountTierAlias(tier) === normalizedAccountTier) return true;
    }
    return false;
  }
  const required = minTier.trim().toLowerCase();
  if (required === "" || required === "free") return true;
  return normalizedAccountTier === normalizeAccountTierAlias(required);
}

function accountAccessRuleRestrictsTier(minTier: string, allowedTiers: string[]): boolean {
  if (allowedTiers.length > 0) return true;
  const required = normalizeAccountTierAlias(minTier);
  return required !== "" && required !== "free";
}

function normalizeAccountTierAlias(tier: string): string {
  const normalized = tier.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "pro-plus" || normalized === "proplus") return "pro+";
  if (normalized === "free-tier") return "free";
  if (normalized === "education" || normalized === "educational" || normalized === "edu" || normalized === "free-educational-quota") return "student";
  return normalized;
}

export function quotaFallbackTier(account: ProviderAccount): string {
  if (account.tier !== null && account.tier.trim() !== "") return account.tier.trim();
  return "free";
}

export function routeError(status: number, message: string, type: string, param: string, code: string): RouteError {
  return { status, message, type, param: param !== "" ? param : null, code: code !== "" ? code : null, retryAfter: null, retryAfterMS: null, accountID: "" };
}
