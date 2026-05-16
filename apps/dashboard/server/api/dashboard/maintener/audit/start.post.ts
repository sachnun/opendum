import { eq } from "drizzle-orm";
import { createError } from "h3";
import { z } from "zod";

import { readDashboardBody, requireMaintenerContext, setAuditUserCookie } from "../../../../utils/api";
import { db } from "../../../../lib/db";
import { user } from "../../../../lib/db/schema";

const startAuditInputSchema = z.object({ userId: z.string().min(1) });

export default defineEventHandler(async (event) => {
  const context = await requireMaintenerContext(event);
  const input = await readDashboardBody(event, startAuditInputSchema);

  if (input.userId === context.actor.id) {
    throw createError({ statusCode: 400, statusMessage: "Cannot audit your own account" });
  }

  const [targetUser] = await db
    .select({ id: user.id, name: user.name, email: user.email, image: user.image })
    .from(user)
    .where(eq(user.id, input.userId))
    .limit(1);

  if (!targetUser) throw createError({ statusCode: 404, statusMessage: "User not found" });

  setAuditUserCookie(event, targetUser.id);

  return { success: true, data: { user: targetUser } } as const;
});
