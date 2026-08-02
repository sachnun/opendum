import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";

import { db, type Database } from "../lib/db";
import { pointTransaction, providerAccount, proxyApiKey, usageLog, userPointBalance } from "../lib/db/schema";

export const API_KEY_UPDATE_POINT_COST = 100;
export const ROAMING_POINT_COST = 2;

type PointDatabase = Pick<Database, "insert" | "select" | "update">;
const INITIAL_POINT_BALANCE = 15;

async function ensureUserPointBalanceWithClient(client: PointDatabase, userId: string): Promise<number> {
  const [created] = await client
      .insert(userPointBalance)
      .values({ userId, balance: INITIAL_POINT_BALANCE })
      .onConflictDoNothing({ target: userPointBalance.userId })
      .returning({ balance: userPointBalance.balance });

  if (created) {
    const idempotencyKey = `initial:${userId}`;

    await client
        .insert(pointTransaction)
        .values({
          userId,
          amount: INITIAL_POINT_BALANCE,
          type: "initial_grant",
          balanceAfter: INITIAL_POINT_BALANCE,
          idempotencyKey,
        })
        .onConflictDoNothing({ target: pointTransaction.idempotencyKey });

    return created.balance;
  }

  const [existing] = await client
      .select({ balance: userPointBalance.balance })
      .from(userPointBalance)
      .where(eq(userPointBalance.userId, userId))
      .limit(1);

  return existing?.balance ?? INITIAL_POINT_BALANCE;
}

export async function ensureUserPointBalance(userId: string): Promise<number> {
  return db.transaction((tx) => ensureUserPointBalanceWithClient(tx, userId));
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
  const roamingPointsByApiKeyId: Record<string, number> = Object.fromEntries(apiKeyIds.map((id) => [id, 0]));

  if (apiKeyIds.length > 0) {
    const rows = await db
      .select({
        apiKeyId: usageLog.proxyApiKeyId,
        pointsUsed: sql<number>`coalesce(count(*) * ${ROAMING_POINT_COST}, 0)`,
      })
      .from(usageLog)
      .innerJoin(providerAccount, eq(usageLog.providerAccountId, providerAccount.id))
      .where(and(
        eq(usageLog.userId, userId),
        inArray(usageLog.proxyApiKeyId, apiKeyIds),
        ne(providerAccount.userId, userId),
        sql`${usageLog.statusCode} >= 200`,
        sql`${usageLog.statusCode} < 400`,
      ))
      .groupBy(usageLog.proxyApiKeyId);

    for (const row of rows) {
      if (row.apiKeyId) roamingPointsByApiKeyId[row.apiKeyId] = Number(row.pointsUsed ?? 0);
    }
  }

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
