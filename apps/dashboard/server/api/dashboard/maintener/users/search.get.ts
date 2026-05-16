import { and, asc, ilike, ne, or } from "drizzle-orm";
import { z } from "zod";

import { getDashboardQuery, requireMaintenerContext } from "../../../../utils/api";
import { db } from "../../../../lib/db";
import { user } from "../../../../lib/db/schema";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 30;

const userSearchInputSchema = z.object({
  q: z.string().trim().max(120).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
}).optional();

export default defineEventHandler(async (event) => {
  const context = await requireMaintenerContext(event);
  const input = getDashboardQuery(event, userSearchInputSchema);
  const query = input?.q?.trim() ?? "";
  const offset = input?.offset ?? 0;
  const limit = input?.limit ?? DEFAULT_LIMIT;

  const conditions = [ne(user.id, context.actor.id)];

  if (query.length > 0) {
    if (query.length < 2) return { users: [], hasMore: false, nextOffset: offset };

    const pattern = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    conditions.push(or(ilike(user.name, pattern), ilike(user.email, pattern))!);
  }

  const rows = await db
    .select({ id: user.id, name: user.name, email: user.email, image: user.image })
    .from(user)
    .where(and(...conditions))
    .orderBy(asc(user.name), asc(user.email), asc(user.id))
    .limit(limit + 1)
    .offset(offset);

  const users = rows.slice(0, limit);

  return {
    users,
    hasMore: rows.length > limit,
    nextOffset: offset + users.length,
  };
});
