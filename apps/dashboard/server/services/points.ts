import { and, eq, gt, gte, inArray, ne, sql } from "drizzle-orm";

import { db, normalizeEmail, pointTransaction, providerEmailRegistry, proxyApiKey, user, userPointBalance, type Database } from "@opendum/database";
import { roamingUsagePointsByApiKey } from "../lib/roaming-points";

export const API_KEY_UPDATE_POINT_COST = 100;
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

async function isUserRewardExcluded(client: PointDatabase, userId: string): Promise<boolean> {
  const [row] = await client.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
  const normalized = row?.email ? normalizeEmail(row.email) : "";
  if (!normalized) return false;

  const [match] = await client
    .select({ email: providerEmailRegistry.email })
    .from(providerEmailRegistry)
    .where(and(
      eq(providerEmailRegistry.email, normalized),
      ne(providerEmailRegistry.userId, userId),
    ))
    .limit(1);

  return Boolean(match);
}

async function applyPointTransactionWithClient(client: PointDatabase, input: PointTransactionInput): Promise<{ applied: boolean; balance: number | null }> {
  const [inserted] = await client
    .insert(pointTransaction)
    .values({
      userId: input.userId,
      amount: input.amount,
      type: input.type,
      balanceAfter: 0,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({ target: pointTransaction.idempotencyKey })
    .returning({ id: pointTransaction.id });

  if (!inserted) return { applied: false, balance: null };

  const [updated] = await client
    .update(userPointBalance)
    .set({
      balance: sql`greatest(${userPointBalance.balance} + ${input.amount}, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(userPointBalance.userId, input.userId))
    .returning({ balance: userPointBalance.balance });

  await client
    .update(pointTransaction)
    .set({ balanceAfter: updated.balance })
    .where(eq(pointTransaction.id, inserted.id));

  return { applied: true, balance: updated.balance };
}

async function revokeUserBonusWithClient(client: PointDatabase, userId: string): Promise<number> {
  const [row] = await client
    .select({ balance: userPointBalance.balance, rewardsExcluded: userPointBalance.rewardsExcluded })
    .from(userPointBalance)
    .where(eq(userPointBalance.userId, userId))
    .limit(1);

  if (!row || row.rewardsExcluded) return row?.balance ?? 0;

  const [bonusRow] = await client
    .select({ bonus: sql<number>`coalesce(sum(${pointTransaction.amount}), 0)` })
    .from(pointTransaction)
    .where(and(
      eq(pointTransaction.userId, userId),
      inArray(pointTransaction.type, BONUS_TRANSACTION_TYPES),
      gt(pointTransaction.amount, 0),
    ));

  const bonus = Number(bonusRow?.bonus ?? 0);
  const deduction = Math.min(bonus, row.balance);

  await client
    .update(userPointBalance)
    .set({ rewardsExcluded: true, rewardsExcludedReason: EXCLUDED_REASON, updatedAt: new Date() })
    .where(eq(userPointBalance.userId, userId));

  if (deduction <= 0) return row.balance;

  const result = await applyPointTransactionWithClient(client, {
    userId,
    amount: -deduction,
    type: "reward_revoke",
    idempotencyKey: `revoke:${userId}`,
  });

  return result.balance ?? row.balance;
}

async function ensureUserPointBalanceWithClient(client: PointDatabase, userId: string): Promise<number> {
  const [existing] = await client
    .select({ balance: userPointBalance.balance, rewardsExcluded: userPointBalance.rewardsExcluded })
    .from(userPointBalance)
    .where(eq(userPointBalance.userId, userId))
    .limit(1);

  if (existing) {
    if (!existing.rewardsExcluded && (await isUserRewardExcluded(client, userId))) {
      return revokeUserBonusWithClient(client, userId);
    }

    return existing.balance;
  }

  const excluded = await isUserRewardExcluded(client, userId);
  const balance = excluded ? 0 : INITIAL_POINT_BALANCE;

  await client
    .insert(userPointBalance)
    .values({
      userId,
      balance,
      rewardsExcluded: excluded,
      rewardsExcludedReason: excluded ? EXCLUDED_REASON : null,
    })
    .onConflictDoNothing({ target: userPointBalance.userId });

  if (excluded) return balance;

  await client
    .insert(pointTransaction)
    .values({
      userId,
      amount: INITIAL_POINT_BALANCE,
      type: "initial_grant",
      balanceAfter: INITIAL_POINT_BALANCE,
      idempotencyKey: `initial:${userId}`,
    })
    .onConflictDoNothing({ target: pointTransaction.idempotencyKey });

  return balance;
}

export async function ensureUserPointBalance(userId: string): Promise<number> {
  return db.transaction((tx) => ensureUserPointBalanceWithClient(tx, userId));
}

export async function trackProviderEmail(userId: string, email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  if (!normalized.includes("@")) return;

  await db
    .insert(providerEmailRegistry)
    .values({ email: normalized, userId })
    .onConflictDoNothing({ target: [providerEmailRegistry.email, providerEmailRegistry.userId] });
}

export async function claimDailyAccessPoints(userId: string): Promise<boolean> {
  const idempotencyKey = `daily:${userId}:${dailyAccessDateKey()}`;

  const [existing] = await db
    .select({ id: pointTransaction.id })
    .from(pointTransaction)
    .where(eq(pointTransaction.idempotencyKey, idempotencyKey))
    .limit(1);
  if (existing) return false;

  return db.transaction(async (tx) => {
    await ensureUserPointBalanceWithClient(tx, userId);

    const [row] = await tx
      .select({ rewardsExcluded: userPointBalance.rewardsExcluded })
      .from(userPointBalance)
      .where(eq(userPointBalance.userId, userId))
      .limit(1);
    if (!row || row.rewardsExcluded) return false;

    const result = await applyPointTransactionWithClient(tx, {
      userId,
      amount: DAILY_ACCESS_POINTS,
      type: "daily_access",
      idempotencyKey,
    });

    return result.applied;
  });
}

export async function getUserPointStatus(userId: string): Promise<{ balance: number; roamingPointsByApiKeyId: Record<string, number> }> {
  const [balance, roamingApiKeys] = await Promise.all([
    ensureUserPointBalance(userId),
    db
      .select({ id: proxyApiKey.id })
      .from(proxyApiKey)
      .where(and(eq(proxyApiKey.userId, userId), eq(proxyApiKey.roamingEnabled, true))),
  ]);
  const apiKeyIds = roamingApiKeys.map((apiKey) => apiKey.id);
  const pointsByApiKeyId = await roamingUsagePointsByApiKey(userId, apiKeyIds);
  const roamingPointsByApiKeyId: Record<string, number> = Object.fromEntries(apiKeyIds.map((id) => [id, pointsByApiKeyId.get(id) ?? 0]));

  return { balance, roamingPointsByApiKeyId };
}

export async function debitUserPoints(client: PointDatabase, userId: string, amount: number, type: string): Promise<{ success: true; balance: number } | { success: false; balance: number }> {
  if (amount <= 0) throw new Error("Point debit amount must be positive");

  await ensureUserPointBalanceWithClient(client, userId);

  const [debited] = await client
    .update(userPointBalance)
    .set({
      balance: sql`${userPointBalance.balance} - ${amount}`,
      updatedAt: new Date(),
    })
    .where(and(eq(userPointBalance.userId, userId), gte(userPointBalance.balance, amount)))
    .returning({ balance: userPointBalance.balance });

  if (!debited) {
    const [existing] = await client
      .select({ balance: userPointBalance.balance })
      .from(userPointBalance)
      .where(eq(userPointBalance.userId, userId))
      .limit(1);

    return { success: false, balance: existing?.balance ?? 0 };
  }

  await client.insert(pointTransaction).values({
    userId,
    amount: -amount,
    type,
    balanceAfter: debited.balance,
  });

  return { success: true, balance: debited.balance };
}
