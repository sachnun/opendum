import { eq } from "drizzle-orm";

import { db } from "../lib/db";
import { pointTransaction, userPointBalance } from "../lib/db/schema";

export const INITIAL_POINT_BALANCE = 15;

export async function ensureUserPointBalance(userId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(userPointBalance)
      .values({ userId, balance: INITIAL_POINT_BALANCE })
      .onConflictDoNothing({ target: userPointBalance.userId })
      .returning({ balance: userPointBalance.balance });

    if (created) {
      const idempotencyKey = `initial:${userId}`;

      await tx
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

    const [existing] = await tx
      .select({ balance: userPointBalance.balance })
      .from(userPointBalance)
      .where(eq(userPointBalance.userId, userId))
      .limit(1);

    return existing?.balance ?? INITIAL_POINT_BALANCE;
  });
}
