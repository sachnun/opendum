import { and, eq, isNotNull } from "drizzle-orm";

import { db, type Database } from "#database/client.ts";
import { providerAccountModelHealth } from "#database/schema/accounts.ts";

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
