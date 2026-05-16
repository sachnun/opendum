import { ilike, or } from "drizzle-orm";
import { z } from "zod";

import { getDashboardQuery, requireMaintenerContext } from "../../../../utils/api";
import { db } from "../../../../lib/db";
import { user } from "../../../../lib/db/schema";

const userSearchInputSchema = z.object({ q: z.string().trim().max(120).optional() }).optional();

export default defineEventHandler(async (event) => {
  const context = await requireMaintenerContext(event);
  const input = getDashboardQuery(event, userSearchInputSchema);
  const query = input?.q?.trim() ?? "";

  if (query.length < 2) return [];

  const pattern = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;

  return db
    .select({ id: user.id, name: user.name, email: user.email, image: user.image })
    .from(user)
    .where(or(ilike(user.name, pattern), ilike(user.email, pattern)))
    .limit(20)
    .then((rows) => rows.filter((row) => row.id !== context.actor.id));
});
