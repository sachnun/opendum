import { and, eq, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { Effect } from "effect";
import { db, type DbExecutor } from "../client.js";
import { tryDb } from "../errors.js";
import { providerAccount, providerAccountDisabledModel } from "../schema/accounts.js";
import { disabledModel } from "../schema/keys.js";
import { userSharingSetting } from "../schema/usage.js";

export const listDisabledModelsByUser = Effect.fn("db.listDisabledModelsByUser")(function* (
  userId: string,
  database: DbExecutor = db
) {
  const rows = yield* tryDb("listDisabledModelsByUser", () =>
    database.select({ model: disabledModel.model }).from(disabledModel).where(eq(disabledModel.userId, userId))
  );
  return rows.map((row) => row.model);
});

export const listActiveAccountTiers = Effect.fn("db.listActiveAccountTiers")(function* (
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
  return yield* tryDb("listActiveAccountTiers", () =>
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

export const listDisabledModelsByAccounts = Effect.fn("db.listDisabledModelsByAccounts")(function* (
  accountIds: string[],
  database: DbExecutor = db
) {
  if (accountIds.length === 0) return [];
  return yield* tryDb("listDisabledModelsByAccounts", () =>
    database
      .select({
        providerAccountId: providerAccountDisabledModel.providerAccountId,
        model: providerAccountDisabledModel.model,
      })
      .from(providerAccountDisabledModel)
      .where(inArray(providerAccountDisabledModel.providerAccountId, accountIds))
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
