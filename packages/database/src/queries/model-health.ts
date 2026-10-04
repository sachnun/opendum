import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db, type Database } from "#database/client.ts";
import { providerAccount, providerAccountModelHealth } from "#database/schema/accounts.ts";

export async function bumpAccountRequestCount(
  params: { id: string; at: Date },
  database: Database = db
) {
  await database
    .update(providerAccount)
    .set({ lastUsedAt: params.at, requestCount: sql`${providerAccount.requestCount} + 1` })
    .where(eq(providerAccount.id, params.id));
}

export async function getAccountHealthState(id: string, database: Database = db) {
  const [row] = await database
    .select({
      id: providerAccount.id,
      status: providerAccount.status,
      disabledUntil: providerAccount.disabledUntil,
      consecutiveErrors: providerAccount.consecutiveErrors,
    })
    .from(providerAccount)
    .where(eq(providerAccount.id, id))
    .limit(1);
  return row ?? null;
}

export async function setAccountHealthFailed(
  params: { id: string; consecutiveErrors: number; status: string; at: Date },
  database: Database = db
) {
  await database
    .update(providerAccount)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      status: params.status,
      statusChangedAt: params.at,
    })
    .where(eq(providerAccount.id, params.id));
}

export async function setAccountCooldown(
  params: {
    id: string;
    status: string;
    at: Date;
    consecutiveErrors: number;
    disabledUntil: Date;
  },
  database: Database = db
) {
  await database
    .update(providerAccount)
    .set({
      status: params.status,
      statusChangedAt: params.at,
      consecutiveErrors: params.consecutiveErrors,
      disabledUntil: params.disabledUntil,
    })
    .where(eq(providerAccount.id, params.id));
}

export async function setAccountActive(
  params: { id: string; status: string; at: Date; consecutiveErrors: number },
  database: Database = db
) {
  await database
    .update(providerAccount)
    .set({
      status: params.status,
      statusChangedAt: params.at,
      consecutiveErrors: params.consecutiveErrors,
      disabledUntil: null,
    })
    .where(eq(providerAccount.id, params.id));
}

export async function setAccountUsageLimited(
  params: { id: string; disabledUntil: Date; status: string; at: Date },
  database: Database = db
) {
  await database
    .update(providerAccount)
    .set({ disabledUntil: params.disabledUntil, status: params.status, statusChangedAt: params.at })
    .where(eq(providerAccount.id, params.id));
}

export async function recordRequestError(
  params: { id: string; at: Date; code: number | null },
  database: Database = db
) {
  await database
    .update(providerAccount)
    .set({
      errorCount: sql`${providerAccount.errorCount} + 1`,
      lastErrorAt: params.at,
      lastErrorCode: params.code,
    })
    .where(eq(providerAccount.id, params.id));
}

export async function markAccountSuccess(
  params: { id: string; at: Date },
  database: Database = db
) {
  await database
    .update(providerAccount)
    .set({ successCount: sql`${providerAccount.successCount} + 1`, lastSuccessAt: params.at })
    .where(eq(providerAccount.id, params.id));
}

export async function markAccountRecoveredByRotation(
  params: { id: string; at: Date; beforeOrAt: Date },
  database: Database = db
) {
  await database
    .update(providerAccount)
    .set({ lastRecoveredByRotationAt: params.at })
    .where(and(eq(providerAccount.id, params.id), lte(providerAccount.lastErrorAt, params.beforeOrAt)));
}

export const modelHealthColumns = {
  id: providerAccountModelHealth.id,
  providerAccountId: providerAccountModelHealth.providerAccountId,
  model: providerAccountModelHealth.model,
  consecutiveErrors: providerAccountModelHealth.consecutiveErrors,
  status: providerAccountModelHealth.status,
  statusChangedAt: providerAccountModelHealth.statusChangedAt,
  lastErrorAt: providerAccountModelHealth.lastErrorAt,
  lastErrorCode: providerAccountModelHealth.lastErrorCode,
  lastSuccessAt: providerAccountModelHealth.lastSuccessAt,
  unhealthyCountUpdatedAt: providerAccountModelHealth.unhealthyCountUpdatedAt,
  createdAt: providerAccountModelHealth.createdAt,
  updatedAt: providerAccountModelHealth.updatedAt,
  quotaLockedUntil: providerAccountModelHealth.quotaLockedUntil,
  quotaLockReason: providerAccountModelHealth.quotaLockReason,
} as const;

export async function listModelHealthByAccounts(
  params: { accountIds: string[]; models: string[] },
  database: Database = db
) {
  if (params.accountIds.length === 0 || params.models.length === 0) return [];
  return database
    .select(modelHealthColumns)
    .from(providerAccountModelHealth)
    .where(
      and(
        inArray(providerAccountModelHealth.providerAccountId, params.accountIds),
        inArray(providerAccountModelHealth.model, params.models)
      )
    );
}

export async function listModelHealthByAccount(accountId: string, database: Database = db) {
  return database
    .select(modelHealthColumns)
    .from(providerAccountModelHealth)
    .where(eq(providerAccountModelHealth.providerAccountId, accountId));
}

export async function getModelHealth(
  accountId: string,
  model: string,
  database: Database = db
) {
  const [row] = await database
    .select(modelHealthColumns)
    .from(providerAccountModelHealth)
    .where(
      and(
        eq(providerAccountModelHealth.providerAccountId, accountId),
        eq(providerAccountModelHealth.model, model)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function updateModelHealthCounters(
  params: { id: string; consecutiveErrors: number; unhealthyCountUpdatedAt: Date },
  database: Database = db
) {
  await database
    .update(providerAccountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
    })
    .where(eq(providerAccountModelHealth.id, params.id));
}

export async function updateModelHealthStatus(
  params: {
    id: string;
    consecutiveErrors: number;
    unhealthyCountUpdatedAt: Date;
    status: string;
    statusChangedAt: Date;
  },
  database: Database = db
) {
  await database
    .update(providerAccountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
      status: params.status,
      statusChangedAt: params.statusChangedAt,
    })
    .where(eq(providerAccountModelHealth.id, params.id));
}

export async function insertModelHealth(
  params: {
    id: string;
    providerAccountId: string;
    model: string;
    consecutiveErrors: number;
    status: string;
    lastErrorAt: Date | null;
    lastErrorCode: number | null;
    unhealthyCountUpdatedAt: Date;
    createdAt: Date;
    updatedAt: Date;
  },
  database: Database = db
) {
  await database.insert(providerAccountModelHealth).values(params);
}

export async function markUsageLimitedHealth(
  params: { providerAccountId: string; model: string; status: string; at: Date; consecutiveErrors: number },
  database: Database = db
) {
  await database
    .update(providerAccountModelHealth)
    .set({
      status: params.status,
      statusChangedAt: params.at,
      consecutiveErrors: params.consecutiveErrors,
      lastErrorAt: params.at,
      unhealthyCountUpdatedAt: params.at,
    })
    .where(
      and(
        eq(providerAccountModelHealth.providerAccountId, params.providerAccountId),
        eq(providerAccountModelHealth.model, params.model)
      )
    );
}

export async function updateModelHealthSuccess(
  params: {
    id: string;
    consecutiveErrors: number;
    lastSuccessAt: Date;
    unhealthyCountUpdatedAt: Date;
  },
  database: Database = db
) {
  await database
    .update(providerAccountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      lastSuccessAt: params.lastSuccessAt,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
    })
    .where(eq(providerAccountModelHealth.id, params.id));
}

export async function updateModelHealthSuccessWithStatus(
  params: {
    id: string;
    consecutiveErrors: number;
    lastSuccessAt: Date;
    unhealthyCountUpdatedAt: Date;
    status: string;
    statusChangedAt: Date;
  },
  database: Database = db
) {
  await database
    .update(providerAccountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      lastSuccessAt: params.lastSuccessAt,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
      status: params.status,
      statusChangedAt: params.statusChangedAt,
    })
    .where(eq(providerAccountModelHealth.id, params.id));
}

export async function updateModelHealthFailure(
  params: {
    id: string;
    consecutiveErrors: number;
    lastErrorAt: Date;
    lastErrorCode: number | null;
    unhealthyCountUpdatedAt: Date;
  },
  database: Database = db
) {
  await database
    .update(providerAccountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      lastErrorAt: params.lastErrorAt,
      lastErrorCode: params.lastErrorCode,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
    })
    .where(eq(providerAccountModelHealth.id, params.id));
}

export async function updateModelHealthFailureWithStatus(
  params: {
    id: string;
    consecutiveErrors: number;
    lastErrorAt: Date;
    lastErrorCode: number | null;
    unhealthyCountUpdatedAt: Date;
    status: string;
    statusChangedAt: Date;
  },
  database: Database = db
) {
  await database
    .update(providerAccountModelHealth)
    .set({
      consecutiveErrors: params.consecutiveErrors,
      lastErrorAt: params.lastErrorAt,
      lastErrorCode: params.lastErrorCode,
      unhealthyCountUpdatedAt: params.unhealthyCountUpdatedAt,
      status: params.status,
      statusChangedAt: params.statusChangedAt,
    })
    .where(eq(providerAccountModelHealth.id, params.id));
}

export async function lockModelQuota(
  params: {
    id: string;
    providerAccountId: string;
    model: string;
    quotaLockedUntil: Date | null;
    quotaLockReason: string | null;
    at: Date;
  },
  database: Database = db
) {
  await database
    .insert(providerAccountModelHealth)
    .values({
      id: params.id,
      providerAccountId: params.providerAccountId,
      model: params.model,
      consecutiveErrors: 0,
      status: "active",
      quotaLockedUntil: params.quotaLockedUntil,
      quotaLockReason: params.quotaLockReason,
      createdAt: params.at,
      updatedAt: params.at,
    })
    .onConflictDoUpdate({
      target: [providerAccountModelHealth.providerAccountId, providerAccountModelHealth.model],
      set: {
        quotaLockedUntil: params.quotaLockedUntil,
        quotaLockReason: params.quotaLockReason,
        updatedAt: params.at,
      },
    });
}

export async function clearModelQuotaLock(
  params: { providerAccountId: string; model: string },
  database: Database = db
) {
  await database
    .update(providerAccountModelHealth)
    .set({ quotaLockedUntil: null, quotaLockReason: null })
    .where(
      and(
        eq(providerAccountModelHealth.providerAccountId, params.providerAccountId),
        eq(providerAccountModelHealth.model, params.model),
        isNotNull(providerAccountModelHealth.quotaLockedUntil)
      )
    );
}
