import { and, eq, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { Effect } from "effect";
import { db, type DbExecutor } from "@opendum/database/client";
import { tryDb } from "@opendum/database/errors";
import { providerAccount, accountDisabledModel } from "@opendum/database/schema/accounts";
import { disabledModel } from "@opendum/database/schema/keys";
import { userSharingSetting } from "@opendum/database/schema/usage";

export const disabledByUser = Effect.fn("db.disabledByUser")(function* (
  userId: string,
  database: DbExecutor = db
) {
  const rows = yield* tryDb("disabledByUser", () =>
    database.select({ model: disabledModel.model }).from(disabledModel).where(eq(disabledModel.userId, userId))
  );
  return rows.map((row) => row.model);
});

export const activeTiers = Effect.fn("db.activeTiers")(function* (
  userId: string,
  now: Date,
  includeInactive = false,
  database: DbExecutor = db
) {
  const conditions = [eq(providerAccount.userId, userId)];
  if (!includeInactive) {
    conditions.push(eq(providerAccount.isActive, true));
    conditions.push(or(isNull(providerAccount.disabledUntil), lte(providerAccount.disabledUntil, now))!);
  }
  return yield* tryDb("activeTiers", () =>
    database
      .select({
        id: providerAccount.id,
        provider: providerAccount.provider,
        tier: providerAccount.tier,
      })
      .from(providerAccount)
      .where(and(...conditions))
  );
});

export const disabledByAccounts = Effect.fn("db.disabledByAccounts")(function* (
  accountIds: string[],
  database: DbExecutor = db
) {
  if (accountIds.length === 0) return [];
  return yield* tryDb("disabledByAccounts", () =>
    database
      .select({
        providerAccountId: accountDisabledModel.providerAccountId,
        model: accountDisabledModel.model,
      })
      .from(accountDisabledModel)
      .where(inArray(accountDisabledModel.providerAccountId, accountIds))
  );
});

export const listSharedAccounts = Effect.fn("db.listSharedAccounts")(function* (
  userId: string,
  now: Date,
  database: DbExecutor = db
) {
  return yield* tryDb("listSharedAccounts", () =>
    database
      .select({
        id: providerAccount.id,
        provider: providerAccount.provider,
        tier: providerAccount.tier,
      })
      .from(providerAccount)
      .innerJoin(userSharingSetting, eq(userSharingSetting.userId, providerAccount.userId))
      .where(
        and(
          ne(providerAccount.userId, userId),
          eq(userSharingSetting.enabled, true),
          eq(providerAccount.isActive, true),
          or(isNull(providerAccount.disabledUntil), lte(providerAccount.disabledUntil, now))
        )
      )
  );
});
