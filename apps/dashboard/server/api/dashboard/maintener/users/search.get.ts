import { and, asc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { getDashboardQuery, requireMaintenerContext } from "../../../../utils/api";
import { db } from "../../../../lib/db";
import { providerAccount, usageLog, user } from "../../../../lib/db/schema";
import { getAccountIndicator } from "../../../../services/account-stats";
import { PROVIDER_ACCOUNT_KEYS } from "../../../../services/account-providers";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 30;

const userSearchInputSchema = z.object({
  q: z.string().trim().max(120).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
}).optional();

function accountIsEffectivelyActive(account: { isActive: boolean; disabledUntil: Date | string | null }, now = new Date()) {
  if (!account.isActive) return false;
  if (!account.disabledUntil) return true;

  const disabledUntil = account.disabledUntil instanceof Date ? account.disabledUntil : new Date(account.disabledUntil);
  return Number.isNaN(disabledUntil.getTime()) || disabledUntil <= now;
}

export default defineEventHandler(async (event) => {
  const context = await requireMaintenerContext(event);
  const input = getDashboardQuery(event, userSearchInputSchema);
  const query = input?.q?.trim() ?? "";
  const offset = input?.offset ?? 0;
  const limit = input?.limit ?? DEFAULT_LIMIT;

  const conditions = [ne(user.id, context.actor.id)];
  const lastUsedAt = sql<Date | null>`max(${usageLog.createdAt})`;

  if (query.length > 0) {
    if (query.length < 2) return { users: [], hasMore: false, nextOffset: offset };

    const pattern = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    conditions.push(or(ilike(user.name, pattern), ilike(user.email, pattern))!);
  }

  const rows = await db
    .select({ id: user.id, name: user.name, email: user.email, image: user.image, lastUsedAt })
    .from(user)
    .leftJoin(usageLog, eq(usageLog.userId, user.id))
    .where(and(...conditions))
    .groupBy(user.id)
    .orderBy(sql`${lastUsedAt} desc nulls last`, asc(user.name), asc(user.email), asc(user.id))
    .limit(limit + 1)
    .offset(offset);

  const users = rows.slice(0, limit);
  const userIds = users.map((item) => item.id);
  const providerIssueUserIds = new Set<string>();

  if (userIds.length > 0) {
    const now = new Date();
    const accountRows = await db
      .select({
        userId: providerAccount.userId,
        isActive: providerAccount.isActive,
        disabledUntil: providerAccount.disabledUntil,
        lastUsedAt: providerAccount.lastUsedAt,
        lastErrorAt: providerAccount.lastErrorAt,
        lastSuccessAt: providerAccount.lastSuccessAt,
        lastRecoveredByRotationAt: providerAccount.lastRecoveredByRotationAt,
      })
      .from(providerAccount)
      .where(and(
        inArray(providerAccount.userId, userIds),
        inArray(providerAccount.provider, PROVIDER_ACCOUNT_KEYS),
        eq(providerAccount.isActive, true),
        sql`${providerAccount.lastErrorAt} is not null`,
      ));

    for (const account of accountRows) {
      if (!accountIsEffectivelyActive(account, now)) continue;

      const indicator = getAccountIndicator(account.lastErrorAt, account.lastSuccessAt, account.lastRecoveredByRotationAt, account.lastUsedAt);
      if (indicator === "error") providerIssueUserIds.add(account.userId);
    }
  }

  return {
    users: users.map((item) => ({ ...item, hasProviderIssue: providerIssueUserIds.has(item.id) })),
    hasMore: rows.length > limit,
    nextOffset: offset + users.length,
  };
});
