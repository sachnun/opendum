import { Effect } from "effect";
import type { Database } from "@opendum/database";
import {
  bumpAccountRequestCount,
  getAccountHealthState,
  getAccountOwnerUserID,
  getModelHealth,
  insertModelHealth,
  listModelHealthByAccount,
  markAccountRecoveredByRotation,
  markAccountSuccess,
  markUsageLimitedHealth,
  recordRequestError,
  setAccountActive,
  setAccountCooldown,
  setAccountHealthFailed,
  setAccountUsageLimited,
  updateModelHealthCounters,
  updateModelHealthFailure,
  updateModelHealthFailureWithStatus,
  updateModelHealthStatus,
  updateModelHealthSuccess,
  updateModelHealthSuccessWithStatus,
} from "@opendum/database/queries";
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
  database: Database;
  models: Registry;
  redis: OpendumRedis;
};

/**
 * Owns every provider-account health transition: per-model health counters,
 * account cooldowns, rotation recovery, request counts and error history.
 */
export class AccountHealthService {
  private readonly database: Database;
  private readonly models: Registry;
  private readonly redis: OpendumRedis;

  constructor(options: AccountHealthOptions) {
    this.database = options.database;
    this.models = options.models;
    this.redis = options.redis;
  }

  async refreshAccountHealthFromModels(accountId: string, now: Date): Promise<boolean> {
    if (isSyntheticProviderAccountId(accountId)) return false;
    const account = await getAccountHealthState(accountId, this.database);
    if (!account) return false;
    const rows = await listModelHealthByAccount(accountId, this.database);
    const applyCooldownRecovery =
      account.status === "failed" && account.disabledUntil !== null && account.disabledUntil.getTime() <= now.getTime();
    const total = await this.normalizeModelHealthRows(rows, now, applyCooldownRecovery);

    if (account.disabledUntil && account.disabledUntil.getTime() > now.getTime()) {
      if (account.consecutiveErrors !== total) {
        await setAccountHealthFailed(
          { id: accountId, consecutiveErrors: total, status: "failed", at: now },
          this.database
        );
      }
      return true;
    }
    if (total >= ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD) {
      await setAccountCooldown(
        {
          id: accountId,
          status: "failed",
          at: now,
          consecutiveErrors: total,
          disabledUntil: new Date(now.getTime() + FAILED_COOLDOWN_MS),
        },
        this.database
      );
      return true;
    }
    if (
      account.status !== "active" ||
      (account.disabledUntil !== null && account.disabledUntil.getTime() <= now.getTime()) ||
      account.consecutiveErrors !== total
    ) {
      await setAccountActive({ id: accountId, status: "active", at: now, consecutiveErrors: total }, this.database);
    }
    return false;
  }

  private async normalizeModelHealthRows(
    rows: Awaited<ReturnType<typeof listModelHealthByAccount>>,
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
        await updateModelHealthStatus(
          { id: row.id, consecutiveErrors: count, unhealthyCountUpdatedAt: now, status, statusChangedAt: now },
          this.database
        );
        continue;
      }
      await updateModelHealthCounters(
        { id: row.id, consecutiveErrors: count, unhealthyCountUpdatedAt: now },
        this.database
      );
    }
    return total;
  }

  async markAccountSuccess(accountId: string, model: string): Promise<void> {
    if (isSyntheticProviderAccountId(accountId)) return;
    const now = new Date();
    await markAccountSuccess({ id: accountId, at: now }, this.database);
    const resolved = this.models.resolveAlias(model);
    const health = await getModelHealth(accountId, resolved, this.database);
    if (!health) {
      await this.refreshAccountHealthFromModels(accountId, now);
      return;
    }
    const nextErrors = successRecoveryCount(health, now);
    const nextStatus = modelHealthStatus(nextErrors);
    if (nextStatus !== health.status) {
      await updateModelHealthSuccessWithStatus(
        {
          id: health.id,
          consecutiveErrors: nextErrors,
          lastSuccessAt: now,
          unhealthyCountUpdatedAt: now,
          status: nextStatus,
          statusChangedAt: now,
        },
        this.database
      );
    } else {
      await updateModelHealthSuccess(
        { id: health.id, consecutiveErrors: nextErrors, lastSuccessAt: now, unhealthyCountUpdatedAt: now },
        this.database
      );
    }
    await this.refreshAccountHealthFromModels(accountId, now);
  }

  async markAccountFailed(accountId: string, model: string, statusCode: number, message: string): Promise<Date> {
    const now = new Date();
    if (isSyntheticProviderAccountId(accountId)) return now;
    const stored = message.length > MAX_STORED_ERROR_LEN ? message.slice(0, MAX_STORED_ERROR_LEN) : message;
    await recordRequestError({ id: accountId, at: now, code: statusCode }, this.database);
    const resolved = this.models.resolveAlias(model);
    const health = await getModelHealth(accountId, resolved, this.database);
    if (health) {
      const nextErrors = effectiveUnhealthyCount(health, now) + 1;
      const nextStatus = modelHealthStatus(nextErrors);
      if (nextStatus !== health.status) {
        await updateModelHealthFailureWithStatus(
          {
            id: health.id,
            consecutiveErrors: nextErrors,
            lastErrorAt: now,
            lastErrorCode: statusCode,
            unhealthyCountUpdatedAt: now,
            status: nextStatus,
            statusChangedAt: now,
          },
          this.database
        );
      } else {
        await updateModelHealthFailure(
          {
            id: health.id,
            consecutiveErrors: nextErrors,
            lastErrorAt: now,
            lastErrorCode: statusCode,
            unhealthyCountUpdatedAt: now,
          },
          this.database
        );
      }
    } else {
      const nextErrors = 1;
      await insertModelHealth(
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
        },
        this.database
      );
    }
    await this.refreshAccountHealthFromModels(accountId, now);
    const ownerUserId = await getAccountOwnerUserID(accountId, this.database);
    if (ownerUserId) {
      await upsertErrorHistory(this.redis, accountId, ownerUserId, resolved, statusCode, stored, now);
    }
    return now;
  }

  async markAccountUsageLimited(accountId: string, model: string, disabledUntil: Date, failedAt: Date): Promise<void> {
    if (isSyntheticProviderAccountId(accountId)) return;
    const resolved = this.models.resolveAlias(model);
    await markUsageLimitedHealth(
      {
        providerAccountId: accountId,
        model: resolved,
        status: "failed",
        at: failedAt,
        consecutiveErrors: ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD,
      },
      this.database
    );
    await this.refreshAccountHealthFromModels(accountId, failedAt);
    await setAccountUsageLimited(
      { id: accountId, disabledUntil, status: "failed", at: failedAt },
      this.database
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
      await markAccountRecoveredByRotation({ id: accountId, at: recoveredAt, beforeOrAt: failedAt }, this.database);
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
    void Effect.runFork(ignoringErrors(() => bumpAccountRequestCount({ id: accountId, at: new Date() }, this.database)));
  }
}
