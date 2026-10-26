import { Effect } from "effect";
import type { DatabaseFailure } from "@opendum/database";
import type { HealthPort, AccountPort } from "@opendum/api/core/repositories";
import type { OpendumRedis } from "@opendum/core/redis";
import type { Registry } from "@opendum/models/runtime";
import { upsertHistory } from "@opendum/api/core/error-history";
import {
  recoveryCount,
  unhealthyCount,
  isSynthetic,
  healthStatus,
  successRecovery,
} from "@opendum/api/core/service-helpers";
import type { Failure } from "@opendum/api/core/types";
import { trackWork } from "@opendum/api/core/pending";

export const MAX_ERROR_LEN = 10000;

const FAILED_COOLDOWN_MS = 10 * 60 * 1000;
const UNHEALTHY_THRESHOLD = 10;

export type Options = {
  accounts: AccountPort;
  health: HealthPort;
  models: Registry;
  redis: OpendumRedis;
};

export class Health {
  private readonly accounts: AccountPort;
  private readonly health: HealthPort;
  private readonly models: Registry;
  private readonly redis: OpendumRedis;

  constructor(options: Options) {
    this.accounts = options.accounts;
    this.health = options.health;
    this.models = options.models;
    this.redis = options.redis;
  }

  refresh(accountId: string, now: Date): Effect.Effect<boolean, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      if (isSynthetic(accountId)) return false;
      const account = yield* this.health.healthState(accountId);
      if (!account) return false;
      const rows = yield* this.health.healthByAccount(accountId);
      const applyCooldownRecovery =
        account.status === "failed" &&
        account.disabledUntil !== null &&
        account.disabledUntil.getTime() <= now.getTime();
      const total = yield* this.normalizeRows(rows, now, applyCooldownRecovery);

      if (account.disabledUntil && account.disabledUntil.getTime() > now.getTime()) {
        if (account.consecutiveErrors !== total) {
          yield* this.health.markFailed({
            id: accountId,
            consecutiveErrors: total,
            status: "failed",
            at: now,
          });
        }
        return true;
      }
      if (total >= UNHEALTHY_THRESHOLD) {
        yield* this.health.setAccountCooldown({
          id: accountId,
          status: "failed",
          at: now,
          consecutiveErrors: total,
          disabledUntil: new Date(now.getTime() + FAILED_COOLDOWN_MS),
        });
        return true;
      }
      if (
        account.status !== "active" ||
        (account.disabledUntil !== null && account.disabledUntil.getTime() <= now.getTime()) ||
        account.consecutiveErrors !== total
      ) {
        yield* this.health.setAccountActive({
          id: accountId,
          status: "active",
          at: now,
          consecutiveErrors: total,
        });
      }
      return false;
    });
  }

  private normalizeRows(
    rows: Awaited<ReturnType<HealthPort["healthByAccount"]>> extends Effect.Effect<infer A, any, any>
      ? A
      : never,
    now: Date,
    applyCooldownRecovery: boolean
  ): Effect.Effect<number, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      let total = 0;
      for (const row of rows) {
        let count = unhealthyCount(row, now);
        if (applyCooldownRecovery) count = recoveryCount(count);
        const status = healthStatus(count);
        const statusChanged = status !== row.status;
        total += count;
        if (count === row.consecutiveErrors && !statusChanged && !applyCooldownRecovery) continue;
        if (row.status === "failed" || statusChanged) {
          yield* this.health.setStatus({
            id: row.id,
            consecutiveErrors: count,
            unhealthyCountUpdatedAt: now,
            status,
            statusChangedAt: now,
          });
          continue;
        }
        yield* this.health.bumpCounters({
          id: row.id,
          consecutiveErrors: count,
          unhealthyCountUpdatedAt: now,
        });
      }
      return total;
    });
  }

  markAccountSuccess(accountId: string, model: string): Effect.Effect<void, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      if (isSynthetic(accountId)) return;
      const now = new Date();
      yield* this.health.markAccountSuccess({ id: accountId, at: now });
      const resolved = this.models.resolveAlias(model);
      const health = yield* this.health.getModelHealth(accountId, resolved);
      if (!health) {
        yield* this.refresh(accountId, now);
        return;
      }
      const nextErrors = successRecovery(health, now);
      const nextStatus = healthStatus(nextErrors);
      if (nextStatus !== health.status) {
        yield* this.health.successStatus({
          id: health.id,
          consecutiveErrors: nextErrors,
          lastSuccessAt: now,
          unhealthyCountUpdatedAt: now,
          status: nextStatus,
          statusChangedAt: now,
        });
      } else {
        yield* this.health.markSuccess({
          id: health.id,
          consecutiveErrors: nextErrors,
          lastSuccessAt: now,
          unhealthyCountUpdatedAt: now,
        });
      }
      yield* this.refresh(accountId, now);
    });
  }

  markAccountFailed(
    accountId: string,
    model: string,
    statusCode: number,
    message: string
  ): Effect.Effect<Date, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      const now = new Date();
      if (isSynthetic(accountId)) return now;
      const stored = message.length > MAX_ERROR_LEN ? message.slice(0, MAX_ERROR_LEN) : message;
      yield* this.health.recordRequestError({ id: accountId, at: now, code: statusCode });
      const resolved = this.models.resolveAlias(model);
      const health = yield* this.health.getModelHealth(accountId, resolved);
      if (health) {
        const nextErrors = unhealthyCount(health, now) + 1;
        const nextStatus = healthStatus(nextErrors);
        if (nextStatus !== health.status) {
          yield* this.health.failStatus({
            id: health.id,
            consecutiveErrors: nextErrors,
            lastErrorAt: now,
            lastErrorCode: statusCode,
            unhealthyCountUpdatedAt: now,
            status: nextStatus,
            statusChangedAt: now,
          });
        } else {
          yield* this.health.recordFailure({
            id: health.id,
            consecutiveErrors: nextErrors,
            lastErrorAt: now,
            lastErrorCode: statusCode,
            unhealthyCountUpdatedAt: now,
          });
        }
      } else {
        const nextErrors = 1;
        yield* this.health.insertModelHealth({
          id: crypto.randomUUID(),
          providerAccountId: accountId,
          model: resolved,
          consecutiveErrors: nextErrors,
          status: healthStatus(nextErrors),
          lastErrorAt: now,
          lastErrorCode: statusCode,
          unhealthyCountUpdatedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
      yield* this.refresh(accountId, now);
      const ownerUserId = yield* this.accounts.ownerId(accountId);
      if (ownerUserId) {
        yield* upsertHistory(this.redis, accountId, ownerUserId, resolved, statusCode, stored, now).pipe(
          Effect.ignore
        );
      }
      return now;
    });
  }

  markUsageLimited(
    accountId: string,
    model: string,
    disabledUntil: Date,
    failedAt: Date
  ): Effect.Effect<void, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      if (isSynthetic(accountId)) return;
      const resolved = this.models.resolveAlias(model);
      yield* this.health.markUsageLimited({
        providerAccountId: accountId,
        model: resolved,
        status: "failed",
        at: failedAt,
        consecutiveErrors: UNHEALTHY_THRESHOLD,
      });
      yield* this.refresh(accountId, failedAt);
      yield* this.health.markLimited({
        id: accountId,
        disabledUntil,
        status: "failed",
        at: failedAt,
      });
    });
  }

  markRecovered(failures: Failure[]): Effect.Effect<void, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      const latest = new Map<string, Date>();
      for (const failure of failures) {
        const existing = latest.get(failure.accountId);
        if (!existing || failure.failedAt.getTime() > existing.getTime()) {
          latest.set(failure.accountId, failure.failedAt);
        }
      }
      if (latest.size === 0) return;
      const recoveredAt = new Date();
      for (const [accountId, failedAt] of latest) {
        if (isSynthetic(accountId)) continue;
        yield* this.health.markRecovered({
          id: accountId,
          at: recoveredAt,
          beforeOrAt: failedAt,
        });
      }
    });
  }

  logAccountError(
    accountId: string,
    userId: string,
    model: string,
    statusCode: number,
    message: string
  ): Effect.Effect<void, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      if (isSynthetic(accountId)) return;
      const stored = message.length > MAX_ERROR_LEN ? message.slice(0, MAX_ERROR_LEN) : message;
      const resolved = this.models.resolveAlias(model);
      yield* upsertHistory(
        this.redis,
        accountId,
        userId,
        resolved,
        statusCode,
        stored,
        new Date()
      ).pipe(Effect.ignore);
    });
  }

  bumpRequest(accountId: string): void {
    if (isSynthetic(accountId)) return;
    const at = new Date();
    trackWork(this.health.bumpRequests({ id: accountId, at }).pipe(Effect.ignore));
  }
}
