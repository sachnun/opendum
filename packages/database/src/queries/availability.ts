import { and, eq, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { db, type Database } from "#database/client.ts";
import { providerAccount, providerAccountDisabledModel } from "#database/schema/accounts.ts";
import { disabledModel } from "#database/schema/keys.ts";
import { userSharingSetting } from "#database/schema/usage.ts";

export async function listDisabledModelsByUser(userId: string, database: Database = db) {
  const rows = await database
    .select({ model: disabledModel.model })
    .from(disabledModel)
    .where(eq(disabledModel.userId, userId));
  return rows.map((row) => row.model);
}

export async function listActiveAccountTiers(
  userId: string,
  now: Date,
  includeInactive = false,
  database: Database = db
) {
  const conditions = [eq(providerAccount.userId, userId)];
  if (!includeInactive) {
    conditions.push(eq(providerAccount.isActive, true));
    conditions.push(or(isNull(providerAccount.disabledUntil), lte(providerAccount.disabledUntil, now))!);
  }
  return database
    .select({
      id: providerAccount.id,
      provider: providerAccount.provider,
      tier: providerAccount.tier,
    })
    .from(providerAccount)
    .where(and(...conditions));
}

export async function listDisabledModelsByAccounts(
  accountIds: string[],
  database: Database = db
) {
  if (accountIds.length === 0) return [];
  return database
    .select({
      providerAccountId: providerAccountDisabledModel.providerAccountId,
      model: providerAccountDisabledModel.model,
    })
    .from(providerAccountDisabledModel)
    .where(inArray(providerAccountDisabledModel.providerAccountId, accountIds));
}

export async function listSharedAccounts(userId: string, now: Date, database: Database = db) {
  return database
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
    );
}
