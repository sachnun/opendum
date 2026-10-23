import { and, eq, gt, gte, inArray, ne, sql } from "drizzle-orm";

import { db, normalizeEmail, pointTransaction, providerEmailRegistry, proxyApiKey, user, userPointBalance, type Database } from "@opendum/database";
import { Effect } from "effect";
import { publishPointsBalance } from "#web/events/bus.js";
import { fromPromise } from "#web/lib/task.js";
import { badRequest } from "#web/errors.js";
import { roamingUsagePointsByApiKey } from "#web/lib/roaming-points.js";

export const API_KEY_UPDATE_POINT_COST = 20;
export const DAILY_ACCESS_POINTS = 5;

const INITIAL_POINT_BALANCE = 15;
const EXCLUDED_REASON = "provider_email";
const BONUS_TRANSACTION_TYPES: string[] = ["initial_grant", "daily_access"];

type PointDatabase = Pick<Database, "insert" | "select" | "update">;

interface PointTransactionInput {
  userId: string;
  amount: number;
  type: string;
  idempotencyKey: string;
}

export function dailyAccessDateKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const isUserRewardExcluded = Effect.fn("points.isUserRewardExcluded")(function* (
  client: PointDatabase,
  userId: string
) {
  const rows = yield* fromPromise(
    () => client.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1),
    "Failed to load user email"
  );
  const normalized = rows[0]?.email ? normalizeEmail(rows[0].email) : "";
  if (!normalized) return false;

  const matches = yield* fromPromise(
    () =>
      client
        .select({ email: providerEmailRegistry.email })
        .from(providerEmailRegistry)
        .where(
          and(eq(providerEmailRegistry.email, normalized), ne(providerEmailRegistry.userId, userId))
        )
        .limit(1),
    "Failed to load provider email registry"
  );

  return matches.length > 0;
});

const applyPointTransactionWithClient = Effect.fn("points.applyPointTransaction")(function* (
  client: PointDatabase,
  input: PointTransactionInput
) {
  const inserted = yield* fromPromise(
    () =>
      client
        .insert(pointTransaction)
        .values({
          userId: input.userId,
          amount: input.amount,
          type: input.type,
          balanceAfter: 0,
          idempotencyKey: input.idempotencyKey,
        })
        .onConflictDoNothing({ target: pointTransaction.idempotencyKey })
        .returning({ id: pointTransaction.id }),
    "Failed to insert point transaction"
  );

  if (!inserted[0]) return { applied: false, balance: null };

  const updated = yield* fromPromise(
    () =>
      client
        .update(userPointBalance)
        .set({
          balance: sql`greatest(${userPointBalance.balance} + ${input.amount}, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(userPointBalance.userId, input.userId))
        .returning({ balance: userPointBalance.balance }),
    "Failed to update point balance"
  );

  const balance = updated[0]!.balance;

  yield* fromPromise(
    () =>
      client
        .update(pointTransaction)
        .set({ balanceAfter: balance })
        .where(eq(pointTransaction.id, inserted[0]!.id)),
    "Failed to update point transaction balance"
  );

  publishPointsBalance(input.userId, balance);

  return { applied: true, balance };
});

const revokeUserBonusWithClient = Effect.fn("points.revokeUserBonus")(function* (
  client: PointDatabase,
  userId: string
) {
  const rows = yield* fromPromise(
    () =>
      client
        .select({ balance: userPointBalance.balance, rewardsExcluded: userPointBalance.rewardsExcluded })
        .from(userPointBalance)
        .where(eq(userPointBalance.userId, userId))
        .limit(1),
    "Failed to load point balance"
  );
  const row = rows[0];
  if (!row || row.rewardsExcluded) return row?.balance ?? 0;

  const bonusRows = yield* fromPromise(
    () =>
      client
        .select({ bonus: sql<number>`coalesce(sum(${pointTransaction.amount}), 0)` })
        .from(pointTransaction)
        .where(
          and(
            eq(pointTransaction.userId, userId),
            inArray(pointTransaction.type, BONUS_TRANSACTION_TYPES),
            gt(pointTransaction.amount, 0)
          )
        ),
    "Failed to sum bonus transactions"
  );

  const bonus = Number(bonusRows[0]?.bonus ?? 0);
  const deduction = Math.min(bonus, row.balance);

  yield* fromPromise(
    () =>
      client
        .update(userPointBalance)
        .set({ rewardsExcluded: true, rewardsExcludedReason: EXCLUDED_REASON, updatedAt: new Date() })
        .where(eq(userPointBalance.userId, userId)),
    "Failed to mark rewards excluded"
  );

  if (deduction <= 0) return row.balance;

  const result = yield* applyPointTransactionWithClient(client, {
    userId,
    amount: -deduction,
    type: "reward_revoke",
    idempotencyKey: `revoke:${userId}`,
  });

  return result.balance ?? row.balance;
});

const ensureUserPointBalanceWithClient = Effect.fn("points.ensureUserPointBalance")(function* (
  client: PointDatabase,
  userId: string
) {
  const rows = yield* fromPromise(
    () =>
      client
        .select({ balance: userPointBalance.balance, rewardsExcluded: userPointBalance.rewardsExcluded })
        .from(userPointBalance)
        .where(eq(userPointBalance.userId, userId))
        .limit(1),
    "Failed to load point balance"
  );
  const existing = rows[0];

  if (existing) {
    if (!existing.rewardsExcluded && (yield* isUserRewardExcluded(client, userId))) {
      return yield* revokeUserBonusWithClient(client, userId);
    }

    return existing.balance;
  }

  const excluded = yield* isUserRewardExcluded(client, userId);
  const balance = excluded ? 0 : INITIAL_POINT_BALANCE;

  yield* fromPromise(
    () =>
      client
        .insert(userPointBalance)
        .values({
          userId,
          balance,
          rewardsExcluded: excluded,
          rewardsExcludedReason: excluded ? EXCLUDED_REASON : null,
        })
        .onConflictDoNothing({ target: userPointBalance.userId }),
    "Failed to create point balance"
  );

  if (excluded) return balance;

  yield* fromPromise(
    () =>
      client
        .insert(pointTransaction)
        .values({
          userId,
          amount: INITIAL_POINT_BALANCE,
          type: "initial_grant",
          balanceAfter: INITIAL_POINT_BALANCE,
          idempotencyKey: `initial:${userId}`,
        })
        .onConflictDoNothing({ target: pointTransaction.idempotencyKey }),
    "Failed to grant initial points"
  );

  return balance;
});

export const ensureUserPointBalance = Effect.fn("points.ensureUserPointBalance")(function* (
  userId: string
) {
  return yield* fromPromise(
    () => db.transaction((tx) => Effect.runPromise(ensureUserPointBalanceWithClient(tx, userId))),
    "Failed to ensure point balance"
  );
});

export const trackProviderEmail = Effect.fn("points.trackProviderEmail")(function* (
  userId: string,
  email: string
) {
  const normalized = normalizeEmail(email);
  if (!normalized.includes("@")) return;

  yield* fromPromise(
    () =>
      db
        .insert(providerEmailRegistry)
        .values({ email: normalized, userId })
        .onConflictDoNothing({ target: [providerEmailRegistry.email, providerEmailRegistry.userId] }),
    "Failed to track provider email"
  );
});

export const claimDailyAccessPoints = Effect.fn("points.claimDailyAccessPoints")(function* (
  userId: string
) {
  const idempotencyKey = `daily:${userId}:${dailyAccessDateKey()}`;

  const existing = yield* fromPromise(
    () =>
      db
        .select({ id: pointTransaction.id })
        .from(pointTransaction)
        .where(eq(pointTransaction.idempotencyKey, idempotencyKey))
        .limit(1),
    "Failed to load daily access transaction"
  );
  if (existing[0]) return false;

  return yield* fromPromise(
    () =>
      db.transaction(async (tx) => {
        await Effect.runPromise(ensureUserPointBalanceWithClient(tx, userId));

        const rows = await tx
          .select({ rewardsExcluded: userPointBalance.rewardsExcluded })
          .from(userPointBalance)
          .where(eq(userPointBalance.userId, userId))
          .limit(1);
        const row = rows[0];
        if (!row || row.rewardsExcluded) return false;

        const result = await Effect.runPromise(
          applyPointTransactionWithClient(tx, {
            userId,
            amount: DAILY_ACCESS_POINTS,
            type: "daily_access",
            idempotencyKey,
          })
        );

        return result.applied;
      }),
    "Failed to claim daily access points"
  );
});

export const getUserPointStatus = Effect.fn("points.getUserPointStatus")(function* (userId: string) {
  const balance = yield* ensureUserPointBalance(userId);
  const roamingApiKeys = yield* fromPromise(
    () =>
      db
        .select({ id: proxyApiKey.id })
        .from(proxyApiKey)
        .where(and(eq(proxyApiKey.userId, userId), eq(proxyApiKey.roamingEnabled, true))),
    "Failed to load roaming api keys"
  );
  const apiKeyIds = roamingApiKeys.map((apiKey) => apiKey.id);
  const pointsByApiKeyId = yield* roamingUsagePointsByApiKey(userId, apiKeyIds);
  const roamingPointsByApiKeyId: Record<string, number> = Object.fromEntries(
    apiKeyIds.map((id) => [id, pointsByApiKeyId.get(id) ?? 0])
  );

  return { balance, roamingPointsByApiKeyId };
});

export const debitUserPoints = Effect.fn("points.debitUserPoints")(function* (
  client: PointDatabase,
  userId: string,
  amount: number,
  type: string
) {
  if (amount <= 0) return yield* badRequest("Point debit amount must be positive");

  yield* ensureUserPointBalanceWithClient(client, userId);

  const debited = yield* fromPromise(
    () =>
      client
        .update(userPointBalance)
        .set({
          balance: sql`${userPointBalance.balance} - ${amount}`,
          updatedAt: new Date(),
        })
        .where(and(eq(userPointBalance.userId, userId), gte(userPointBalance.balance, amount)))
        .returning({ balance: userPointBalance.balance }),
    "Failed to debit point balance"
  );

  if (!debited[0]) {
    const existing = yield* fromPromise(
      () =>
        client
          .select({ balance: userPointBalance.balance })
          .from(userPointBalance)
          .where(eq(userPointBalance.userId, userId))
          .limit(1),
      "Failed to load point balance"
    );

    return { success: false as const, balance: existing[0]?.balance ?? 0 };
  }

  yield* fromPromise(
    () =>
      client.insert(pointTransaction).values({
        userId,
        amount: -amount,
        type,
        balanceAfter: debited[0]!.balance,
      }),
    "Failed to record point transaction"
  );

  publishPointsBalance(userId, debited[0].balance);

  return { success: true as const, balance: debited[0].balance };
});
