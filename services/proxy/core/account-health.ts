import { Effect } from "effect";
import type { ModelHealthPort, ProviderAccountPort } from "./repositories.js";
import type { OpendumRedis } from "@opendum/core/redis";
import type { Registry } from "@opendum/models/runtime";
import { upsertErrorHistory } from "./error-history.js";
import {
  cooldownRecoveryCount,
  effectiveUnhealthyCount,
  ignoringErrors,
  isSyntheticProviderAccountId,
  modelHealthStatus,
  successRecoveryCount,
} from "./service-helpers.js";
import type { AccountRotationFailure } from "./types.js";

export const MAX_STORED_ERROR_LEN = 10000;

const FAILED_COOLDOWN_MS = 10 * 60 * 1000;
const ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD = 10;

export type AccountHealthOptions = {
  accounts: ProviderAccountPort;
  health: ModelHealthPort;
  models: Registry;
  redis: OpendumRedis;
};

/**
 * Owns every provider-account health transition: per-model health counters,
 * account cooldowns, rotation recovery, request counts and error history.
 */
export class AccountHealthService {
  private readonly accounts: ProviderAccountPort;
  private readonly health: ModelHealthPort;
  private readonly models: Registry;
  private readonly redis: OpendumRedis;

  constructor(options: AccountHealthOptions) {
    this.accounts = options.accounts;
    this.health = options.health;
    this.models = options.models;
    this.redis = options.redis;
  }

  async refreshAccountHealthFromModels(accountId: string, now: Date): Promise<boolean> {
    if (isSyntheticProviderAccountId(accountId)) return false;
    const account = await this.health.getAccountHealthState(accountId);
    if (!account) return false;
    const rows = await this.health.listModelHealthByAccount(accountId);
    const applyCooldownRecovery =
      account.status === "failed" && account.disabledUntil !== null && account.disabledUntil.getTime() <= now.getTime();
    const total = await this.normalizeModelHealthRows(rows, now, applyCooldownRecovery);

    if (account.disabledUntil && account.disabledUntil.getTime() > now.getTime()) {
      if (account.consecutiveErrors !== total) {
        await this.health.setAccountHealthFailed(
          { id: accountId, consecutiveErrors: total, status: "failed", at: now }
        );
      }
      return true;
    }
    if (total >= ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD) {
      await this.health.setAccountCooldown(
        {
          id: accountId,
          status: "failed",
          at: now,
          consecutiveErrors: total,
          disabledUntil: new Date(now.getTime() + FAILED_COOLDOWN_MS),
        }
      );
      return true;
    }
    if (
      account.status !== "active" ||
      (account.disabledUntil !== null && account.disabledUntil.getTime() <= now.getTime()) ||
      account.consecutiveErrors !== total
    ) {
      await this.health.setAccountActive({ id: accountId, status: "active", at: now, consecutiveErrors: total });
    }
    return false;
  }

  private async normalizeModelHealthRows(
    rows: Awaited<ReturnType<ModelHealthPort["listModelHealthByAccount"]>>,
    now: Date,
    applyCooldownRecovery: boolean
  ): Promise<number> {
    let total = 0;
    for (const row of rows) {
      let count = effectiveUnhealthyCount(row, now);
      if (applyCooldownRecovery) count = cooldownRecoveryCount(count);
      const status = modelHealthStatus(count);
      const statusChanged = status !== row.status;
      total += count;
      if (count === row.consecutiveErrors && !statusChanged && !applyCooldownRecovery) continue;
      if (row.status === "failed" || statusChanged) {
        await this.health.updateModelHealthStatus(
          { id: row.id, consecutiveErrors: count, unhealthyCountUpdatedAt: now, status, statusChangedAt: now }
        );
        continue;
      }
      await this.health.updateModelHealthCounters(
        { id: row.id, consecutiveErrors: count, unhealthyCountUpdatedAt: now }
      );
    }
    return total;
  }

  async markAccountSuccess(accountId: string, model: string): Promise<void> {
    if (isSyntheticProviderAccountId(accountId)) return;
    const now = new Date();
    await this.health.markAccountSuccess({ id: accountId, at: now });
    const resolved = this.models.resolveAlias(model);
    const health = await this.health.getModelHealth(accountId, resolved);
    if (!health) {
      await this.refreshAccountHealthFromModels(accountId, now);
      return;
    }
    const nextErrors = successRecoveryCount(health, now);
    const nextStatus = modelHealthStatus(nextErrors);
    if (nextStatus !== health.status) {
      await this.health.updateModelHealthSuccessWithStatus(
        {
          id: health.id,
          consecutiveErrors: nextErrors,
          lastSuccessAt: now,
          unhealthyCountUpdatedAt: now,
          status: nextStatus,
          statusChangedAt: now,
        }
      );
    } else {
      await this.health.updateModelHealthSuccess(
        { id: health.id, consecutiveErrors: nextErrors, lastSuccessAt: now, unhealthyCountUpdatedAt: now }
      );
    }
    await this.refreshAccountHealthFromModels(accountId, now);
  }

  async markAccountFailed(accountId: string, model: string, statusCode: number, message: string): Promise<Date> {
    const now = new Date();
    if (isSyntheticProviderAccountId(accountId)) return now;
    const stored = message.length > MAX_STORED_ERROR_LEN ? message.slice(0, MAX_STORED_ERROR_LEN) : message;
    await this.health.recordRequestError({ id: accountId, at: now, code: statusCode });
    const resolved = this.models.resolveAlias(model);
    const health = await this.health.getModelHealth(accountId, resolved);
    if (health) {
      const nextErrors = effectiveUnhealthyCount(health, now) + 1;
      const nextStatus = modelHealthStatus(nextErrors);
      if (nextStatus !== health.status) {
        await this.health.updateModelHealthFailureWithStatus(
          {
            id: health.id,
            consecutiveErrors: nextErrors,
            lastErrorAt: now,
            lastErrorCode: statusCode,
            unhealthyCountUpdatedAt: now,
            status: nextStatus,
            statusChangedAt: now,
          }
        );
      } else {
        await this.health.updateModelHealthFailure(
          {
            id: health.id,
            consecutiveErrors: nextErrors,
            lastErrorAt: now,
            lastErrorCode: statusCode,
            unhealthyCountUpdatedAt: now,
          }
        );
      }
    } else {
      const nextErrors = 1;
      await this.health.insertModelHealth(
        {
          id: crypto.randomUUID(),
          providerAccountId: accountId,
          model: resolved,
          consecutiveErrors: nextErrors,
          status: modelHealthStatus(nextErrors),
          lastErrorAt: now,
          lastErrorCode: statusCode,
          unhealthyCountUpdatedAt: now,
          createdAt: now,
          updatedAt: now,
        }
      );
    }
    await this.refreshAccountHealthFromModels(accountId, now);
    const ownerUserId = await this.accounts.getAccountOwnerUserID(accountId);
    if (ownerUserId) {
      await upsertErrorHistory(this.redis, accountId, ownerUserId, resolved, statusCode, stored, now);
    }
    return now;
  }

  async markAccountUsageLimited(accountId: string, model: string, disabledUntil: Date, failedAt: Date): Promise<void> {
    if (isSyntheticProviderAccountId(accountId)) return;
    const resolved = this.models.resolveAlias(model);
    await this.health.markUsageLimitedHealth(
      {
        providerAccountId: accountId,
        model: resolved,
        status: "failed",
        at: failedAt,
        consecutiveErrors: ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD,
      }
    );
    await this.refreshAccountHealthFromModels(accountId, failedAt);
    await this.health.setAccountUsageLimited(
      { id: accountId, disabledUntil, status: "failed", at: failedAt }
    );
  }

  async markAccountsRecoveredByRotation(failures: AccountRotationFailure[]): Promise<void> {
    const latest = new Map<string, Date>();
    for (const failure of failures) {
      const existing = latest.get(failure.accountId);
      if (!existing || failure.failedAt.getTime() > existing.getTime()) latest.set(failure.accountId, failure.failedAt);
    }
    if (latest.size === 0) return;
    const recoveredAt = new Date();
    for (const [accountId, failedAt] of latest) {
      if (isSyntheticProviderAccountId(accountId)) continue;
      await this.health.markAccountRecoveredByRotation({ id: accountId, at: recoveredAt, beforeOrAt: failedAt });
    }
  }

  async logAccountError(accountId: string, userId: string, model: string, statusCode: number, message: string): Promise<void> {
    if (isSyntheticProviderAccountId(accountId)) return;
    const stored = message.length > MAX_STORED_ERROR_LEN ? message.slice(0, MAX_STORED_ERROR_LEN) : message;
    const resolved = this.models.resolveAlias(model);
    await upsertErrorHistory(this.redis, accountId, userId, resolved, statusCode, stored, new Date());
  }

  bumpRequestCount(accountId: string): void {
    if (isSyntheticProviderAccountId(accountId)) return;
    void Effect.runFork(ignoringErrors(() => this.health.bumpAccountRequestCount({ id: accountId, at: new Date() })));
  }
}
