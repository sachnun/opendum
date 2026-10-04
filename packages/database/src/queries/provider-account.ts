import { and, asc, eq, inArray, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { db, type Database } from "#database/client.ts";
import {
  providerAccount,
  providerAccountDisabledModel,
} from "#database/schema/accounts.ts";
import { userSharingSetting } from "#database/schema/usage.ts";

export type EligibleAccountParams = {
  userId: string;
  providers: string[];
  now: Date;
  excludeIds: string[];
  excludeProviders: string[];
  useWhitelist: boolean;
  useBlacklist: boolean;
  accountIds: string[];
};

export async function listEligibleAccounts(
  params: EligibleAccountParams,
  database: Database = db
) {
  const conditions = [
    eq(providerAccount.userId, params.userId),
    inArray(providerAccount.provider, params.providers),
    eq(providerAccount.isActive, true),
    or(isNull(providerAccount.disabledUntil), lte(providerAccount.disabledUntil, params.now)),
  ];

  if (params.excludeProviders.length > 0) {
    conditions.push(notInArray(providerAccount.provider, params.excludeProviders));
  }
  if (params.useWhitelist) {
    conditions.push(inArray(providerAccount.id, params.accountIds));
  } else if (params.useBlacklist) {
    conditions.push(notInArray(providerAccount.id, params.accountIds));
  }

  const rows = await database
    .select({
      id: providerAccount.id,
      userId: providerAccount.userId,
      provider: providerAccount.provider,
      tier: providerAccount.tier,
      status: providerAccount.status,
      lastUsedAt: providerAccount.lastUsedAt,
      createdAt: providerAccount.createdAt,
      accountId: providerAccount.accountId,
      disabledUntil: providerAccount.disabledUntil,
    })
    .from(providerAccount)
    .where(and(...conditions))
    .orderBy(
      asc(providerAccount.status),
      sql`${providerAccount.lastUsedAt} asc nulls first`,
      asc(providerAccount.createdAt)
    );

  if (params.excludeIds.length === 0) return rows;
  const excluded = new Set(params.excludeIds);
  return rows.filter((row) => !excluded.has(row.id));
}

export async function listSharedEligibleAccounts(
  params: Omit<EligibleAccountParams, "useWhitelist" | "useBlacklist" | "accountIds">,
  database: Database = db
) {
  const conditions = [
    ne(providerAccount.userId, params.userId),
    eq(userSharingSetting.enabled, true),
    inArray(providerAccount.provider, params.providers),
    eq(providerAccount.isActive, true),
    or(isNull(providerAccount.disabledUntil), lte(providerAccount.disabledUntil, params.now)),
  ];
  if (params.excludeProviders.length > 0) {
    conditions.push(notInArray(providerAccount.provider, params.excludeProviders));
  }

  const rows = await database
    .select({
      id: providerAccount.id,
      userId: providerAccount.userId,
      provider: providerAccount.provider,
      tier: providerAccount.tier,
      status: providerAccount.status,
      lastUsedAt: providerAccount.lastUsedAt,
      createdAt: providerAccount.createdAt,
      accountId: providerAccount.accountId,
      disabledUntil: providerAccount.disabledUntil,
    })
    .from(providerAccount)
    .innerJoin(userSharingSetting, eq(userSharingSetting.userId, providerAccount.userId))
    .where(and(...conditions))
    .orderBy(
      asc(providerAccount.status),
      sql`${providerAccount.lastUsedAt} asc nulls first`,
      asc(providerAccount.createdAt)
    );

  if (params.excludeIds.length === 0) return rows;
  const excluded = new Set(params.excludeIds);
  return rows.filter((row) => !excluded.has(row.id));
}

export async function getQuotaAccount(
  id: string,
  userId: string,
  provider: string,
  database: Database = db
) {
  const [row] = await database
    .select({
      id: providerAccount.id,
      userId: providerAccount.userId,
      provider: providerAccount.provider,
      name: providerAccount.name,
      accessToken: providerAccount.accessToken,
      refreshToken: providerAccount.refreshToken,
      expiresAt: providerAccount.expiresAt,
      apiKey: providerAccount.apiKey,
      projectId: providerAccount.projectId,
      tier: providerAccount.tier,
      accountId: providerAccount.accountId,
      email: providerAccount.email,
      isActive: providerAccount.isActive,
      lastUsedAt: providerAccount.lastUsedAt,
    })
    .from(providerAccount)
    .where(
      and(
        eq(providerAccount.id, id),
        eq(providerAccount.userId, userId),
        eq(providerAccount.provider, provider)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function listExpiringRefreshableAccounts(
  params: { provider: string; now: Date; expiresBefore: Date; batchLimit: number },
  database: Database = db
) {
  return database
    .select({
      id: providerAccount.id,
      userId: providerAccount.userId,
      provider: providerAccount.provider,
      accessToken: providerAccount.accessToken,
      refreshToken: providerAccount.refreshToken,
      expiresAt: providerAccount.expiresAt,
      accountId: providerAccount.accountId,
      projectId: providerAccount.projectId,
      tier: providerAccount.tier,
      email: providerAccount.email,
      isActive: providerAccount.isActive,
    })
    .from(providerAccount)
    .where(
      and(
        eq(providerAccount.isActive, true),
        or(isNull(providerAccount.disabledUntil), lte(providerAccount.disabledUntil, params.now)),
        eq(providerAccount.provider, params.provider),
        ne(providerAccount.refreshToken, ""),
        lte(providerAccount.expiresAt, params.expiresBefore)
      )
    )
    .orderBy(asc(providerAccount.expiresAt))
    .limit(params.batchLimit);
}

export async function getAccountCredentialsByID(id: string, database: Database = db) {
  const [row] = await database
    .select({
      id: providerAccount.id,
      userId: providerAccount.userId,
      provider: providerAccount.provider,
      accessToken: providerAccount.accessToken,
      refreshToken: providerAccount.refreshToken,
      expiresAt: providerAccount.expiresAt,
      accountId: providerAccount.accountId,
      projectId: providerAccount.projectId,
      tier: providerAccount.tier,
      email: providerAccount.email,
      isActive: providerAccount.isActive,
    })
    .from(providerAccount)
    .where(eq(providerAccount.id, id))
    .limit(1);
  return row ?? null;
}

export async function getAccountOwnerUserID(id: string, database: Database = db) {
  const [row] = await database
    .select({ userId: providerAccount.userId })
    .from(providerAccount)
    .where(eq(providerAccount.id, id))
    .limit(1);
  return row?.userId ?? null;
}

export type RefreshedCredentials = {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  projectId: string | null;
  tier: string | null;
  email: string | null;
  accountId: string | null;
};

export async function updateRefreshedCredentials(
  params: RefreshedCredentials,
  database: Database = db
) {
  await database
    .update(providerAccount)
    .set({
      accessToken: params.accessToken,
      refreshToken: params.refreshToken,
      expiresAt: params.expiresAt,
      projectId: params.projectId,
      tier: params.tier,
      email: params.email,
      accountId: params.accountId,
      updatedAt: new Date(),
    })
    .where(eq(providerAccount.id, params.id));
}

export async function recordAccountError(
  params: { id: string; at: Date; code: number | null },
  database: Database = db
) {
  await database
    .update(providerAccount)
    .set({
      errorCount: sql`${providerAccount.errorCount} + 1`,
      lastErrorAt: params.at,
      lastErrorCode: params.code,
      updatedAt: params.at,
    })
    .where(eq(providerAccount.id, params.id));
}

export async function disableFailedAccount(
  params: { id: string; status: string; at: Date },
  database: Database = db
) {
  const result = await database
    .update(providerAccount)
    .set({ isActive: false, status: params.status, statusChangedAt: params.at, updatedAt: params.at })
    .where(and(eq(providerAccount.id, params.id), eq(providerAccount.isActive, true)));
  return result.rowCount ?? 0;
}

export async function updateCodexAccountID(
  params: { id: string; accountId: string | null },
  database: Database = db
) {
  await database
    .update(providerAccount)
    .set({ accountId: params.accountId })
    .where(eq(providerAccount.id, params.id));
}

export async function updateAntigravityAccountInfo(
  params: { id: string; projectId: string | null; tier: string | null; email: string | null },
  database: Database = db
) {
  await database
    .update(providerAccount)
    .set({ projectId: params.projectId, tier: params.tier, email: params.email })
    .where(eq(providerAccount.id, params.id));
}

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

