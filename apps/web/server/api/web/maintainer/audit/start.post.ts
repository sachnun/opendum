import { eq } from "drizzle-orm";
import { z } from "zod";

import { parseBody, requireMaintainerContext, setAuditUserCookie } from "~~/server/utils/api";
import { db, user } from "@opendum/database";

const startAuditInputSchema = z.object({ userId: z.string().min(1) });

export default defineEventHandler(async (event) => {
  const context = await requireMaintainerContext(event);
  const input = await parseBody(event, startAuditInputSchema);

  if (input.userId === context.actor.id) {
    throw createError({ status: 400, statusText: "Cannot audit your own account" });
  }

  const [targetUser] = await db
    .select({ id: user.id, name: user.name, email: user.email, image: user.image })
    .from(user)
    .where(eq(user.id, input.userId))
    .limit(1);

  if (!targetUser) throw createError({ status: 404, statusText: "User not found" });

  setAuditUserCookie(event, targetUser.id);

  return { success: true, data: { user: targetUser } } as const;
});
