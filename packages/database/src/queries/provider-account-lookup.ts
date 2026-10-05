import { and, eq, inArray } from "drizzle-orm";

import { db, type Database } from "#database/client.ts";
import { providerAccount, providerAccountDisabledModel } from "#database/schema/accounts.ts";

export async function getForcedAccount(id: string, userId: string, database: Database = db) {
  const [row] = await database
    .select({
      id: providerAccount.id,
      userId: providerAccount.userId,
      provider: providerAccount.provider,
      tier: providerAccount.tier,
      status: providerAccount.status,
      lastUsedAt: providerAccount.lastUsedAt,
      createdAt: providerAccount.createdAt,
      accountId: providerAccount.accountId,
      isActive: providerAccount.isActive,
      disabledUntil: providerAccount.disabledUntil,
    })
    .from(providerAccount)
    .where(and(eq(providerAccount.id, id), eq(providerAccount.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function listDisabledAccountIDs(
  params: { accountIds: string[]; models: string[] },
  database: Database = db
) {
  if (params.accountIds.length === 0 || params.models.length === 0) return [];
  return database
    .select({
      providerAccountId: providerAccountDisabledModel.providerAccountId,
      model: providerAccountDisabledModel.model,
    })
    .from(providerAccountDisabledModel)
    .where(
      and(
        inArray(providerAccountDisabledModel.providerAccountId, params.accountIds),
        inArray(providerAccountDisabledModel.model, params.models)
      )
    );
}
