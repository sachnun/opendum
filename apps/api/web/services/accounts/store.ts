import { Effect } from "effect";
import { parseJson } from "@opendum/platform/json";
import { db, pinnedProvider, accountModelHealth } from "@opendum/database";
import { fromPromise } from "@opendum/api/web/lib/task";
import { getRedisClient } from "@opendum/api/web/lib/redis";
import { asc, eq, inArray } from "drizzle-orm";
import { PROVIDER_ACCOUNT_KEYS } from "@opendum/api/web/services/account-providers";
import {
  AUTO_PIN_SENTINEL,
  ENTRY_KEY_PREFIX,
  HISTORY_KEY_PREFIX,
  type HealthRow,
  type AccountReadOptions,
  type HistoryEntry,
} from "@opendum/api/web/services/accounts/types";

export type ErrorEntry = {
  id: string;
  model: string | null;
  errorCode: number;
  errorMessage: string;
  createdAt: string;
};

export class ErrorHistory {
  static accountKey(accountId: string): string {
    return `${HISTORY_KEY_PREFIX}:${accountId}`;
  }

  static entryKey(entryId: string): string {
    return `${ENTRY_KEY_PREFIX}:${entryId}`;
  }

  static parse(value: string | null): HistoryEntry | null {
    if (!value) return null;
    const parsed = parseJson(value) as Partial<HistoryEntry> | null;
    if (!parsed) return null;
    if (
      !parsed.id ||
      !parsed.providerAccountId ||
      typeof parsed.errorCode !== "number" ||
      typeof parsed.errorMessage !== "string" ||
      !parsed.createdAt
    ) {
      return null;
    }
    return {
      id: parsed.id,
      providerAccountId: parsed.providerAccountId,
      userId: parsed.userId ?? "",
      model: typeof parsed.model === "string" ? parsed.model : null,
      errorCode: parsed.errorCode,
      errorMessage: parsed.errorMessage,
      createdAt: parsed.createdAt,
      dedupeKey: parsed.dedupeKey,
    };
  }

  static toEntry(entry: HistoryEntry): ErrorEntry {
    return {
      id: entry.id,
      model: entry.model,
      errorCode: entry.errorCode,
      errorMessage: entry.errorMessage,
      createdAt: entry.createdAt,
    };
  }

  static readonly read = Effect.fn("accounts.readRedisErrorHistory")(function* (
    accountId: string,
    limit: number
  ) {
    const redis = yield* getRedisClient();
    const key = ErrorHistory.accountKey(accountId);
    const ids = yield* fromPromise(
      () => redis.zRange(key, 0, Math.max(0, limit - 1), { REV: true }),
      "Failed to read error history"
    );
    if (ids.length === 0) return [] as ErrorEntry[];

    const values = yield* fromPromise(
      () => redis.mGet(ids.map((id) => ErrorHistory.entryKey(id))),
      "Failed to read error history entries"
    );
    const missingIds: string[] = [];
    const entries = values.flatMap((value, index) => {
      const entry = ErrorHistory.parse(value);
      if (!entry || entry.providerAccountId !== accountId) {
        missingIds.push(ids[index] ?? "");
        return [];
      }
      return [ErrorHistory.toEntry(entry)];
    });

    const staleIds = missingIds.filter(Boolean);
    if (staleIds.length > 0) {
      yield* fromPromise(() => redis.zRem(key, staleIds), "Failed to prune error history").pipe(
        Effect.ignore
      );
    }
    return entries;
  });

  static readonly readMany = Effect.fn("accounts.readRedisErrorHistories")(function* (
    accountIds: string[],
    limit: number
  ) {
    const redis = yield* getRedisClient();
    const idsByAccount = Object.fromEntries(
      yield* Effect.forEach(
        accountIds,
        (accountId) =>
          fromPromise(
            () => redis.zRange(ErrorHistory.accountKey(accountId), 0, Math.max(0, limit - 1), { REV: true }),
            "Failed to read error history"
          ).pipe(Effect.map((ids) => [accountId, ids] as const)),
        { concurrency: 4 }
      )
    );
    const entryRefs = Object.entries(idsByAccount).flatMap(([accountId, ids]) =>
      ids.map((id) => ({ accountId, id }))
    );
    const entriesByAccount: Record<string, ErrorEntry[]> = Object.fromEntries(
      accountIds.map((accountId) => [accountId, []])
    );
    if (entryRefs.length === 0) return entriesByAccount;

    const values = yield* fromPromise(
      () => redis.mGet(entryRefs.map(({ id }) => ErrorHistory.entryKey(id))),
      "Failed to read error history entries"
    );
    const missingByAccount: Record<string, string[]> = {};

    for (const [index, value] of values.entries()) {
      const ref = entryRefs[index];
      if (!ref) continue;

      const entry = ErrorHistory.parse(value);
      if (!entry || entry.providerAccountId !== ref.accountId) {
        missingByAccount[ref.accountId] = [
          ...(missingByAccount[ref.accountId] ?? []),
          ref.id,
        ];
        continue;
      }

      entriesByAccount[ref.accountId]?.push(ErrorHistory.toEntry(entry));
    }

    yield* Effect.forEach(
      Object.entries(missingByAccount),
      ([accountId, missingIds]) =>
        fromPromise(
          () => redis.zRem(ErrorHistory.accountKey(accountId), missingIds.filter(Boolean)),
          "Failed to prune error history"
        ).pipe(Effect.ignore),
      { concurrency: 4 }
    );
    return entriesByAccount;
  });

  static readonly remove = Effect.fn("accounts.deleteRedisErrorHistory")(function* (
    accountId: string
  ) {
    const redis = yield* getRedisClient();
    const key = ErrorHistory.accountKey(accountId);
    const ids = yield* fromPromise(
      () => redis.zRange(key, 0, -1),
      "Failed to read error history"
    );
    if (ids.length === 0) {
      yield* fromPromise(() => redis.del(key), "Failed to delete error history").pipe(Effect.ignore);
      return;
    }

    const values = yield* fromPromise(
      () => redis.mGet(ids.map((id) => ErrorHistory.entryKey(id))),
      "Failed to read error history entries"
    );
    const keysToDelete = new Set<string>([key]);
    ids.forEach((id) => keysToDelete.add(ErrorHistory.entryKey(id)));
    for (const value of values) {
      const entry = ErrorHistory.parse(value);
      if (entry?.dedupeKey) keysToDelete.add(entry.dedupeKey);
    }
    yield* fromPromise(() => redis.del(Array.from(keysToDelete)), "Failed to delete error history").pipe(
      Effect.ignore
    );
  });
}

export class HealthRows {
  static readonly load = Effect.fn("accounts.getAccountSummaryHealthRows")(function* (
    accountIds: string[]
  ) {
    if (accountIds.length === 0) return [] as HealthRow[];

    return yield* fromPromise(
      () =>
        db
          .select({
            providerAccountId: accountModelHealth.providerAccountId,
            status: accountModelHealth.status,
            statusChangedAt: accountModelHealth.statusChangedAt,
            consecutiveErrors: accountModelHealth.consecutiveErrors,
            lastErrorAt: accountModelHealth.lastErrorAt,
            lastErrorCode: accountModelHealth.lastErrorCode,
            lastSuccessAt: accountModelHealth.lastSuccessAt,
            unhealthyCountUpdatedAt: accountModelHealth.unhealthyCountUpdatedAt,
          })
          .from(accountModelHealth)
          .where(inArray(accountModelHealth.providerAccountId, accountIds)),
      "Failed to load account health rows"
    );
  });
}

export class Pins {
  static readonly load = Effect.fn("accounts.getPinnedProviderKeys")(function* (
    userId: string,
    providersWithAccounts?: Iterable<string>,
    options: AccountReadOptions = {}
  ) {
    const rows = yield* fromPromise(
      () =>
        db
          .select({ providerKey: pinnedProvider.providerKey })
          .from(pinnedProvider)
          .where(eq(pinnedProvider.userId, userId))
          .orderBy(asc(pinnedProvider.createdAt)),
      "Failed to load pinned providers"
    );

    if (rows.length === 0 && providersWithAccounts && options.autoPin !== false) {
      const providerSet = new Set(providersWithAccounts);
      const autoPinKeys = PROVIDER_ACCOUNT_KEYS.filter((provider) =>
        providerSet.has(provider)
      ).slice(0, 5);
      const rowsToInsert = [
        ...autoPinKeys.map((providerKey) => ({ userId, providerKey })),
        { userId, providerKey: AUTO_PIN_SENTINEL },
      ];

      yield* fromPromise(
        () =>
          db
            .insert(pinnedProvider)
            .values(rowsToInsert)
            .onConflictDoNothing({
              target: [pinnedProvider.userId, pinnedProvider.providerKey],
            }),
        "Failed to pin providers"
      ).pipe(Effect.ignore);

      return autoPinKeys;
    }

    return rows.map((row) => row.providerKey);
  });
}
