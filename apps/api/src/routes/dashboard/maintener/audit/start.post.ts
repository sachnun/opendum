import { eq } from "drizzle-orm";
import { createError } from "../../../../utils/errors.js";
import { z } from "zod";

import { readDashboardBody, requireMaintenerContext, setAuditUserCookie } from "../../../../utils/api";
import { db } from "../../../../lib/db";
import { user } from "../../../../lib/db/schema";

const startAuditInputSchema = z.object({ userId: z.string().min(1) });

import type { Context } from "hono";
export async function handler(c: Context) {

  const context = await requireMaintenerContext(c);
  const input = await readDashboardBody(c, startAuditInputSchema);

  if (input.userId === context.actor.id) {
    throw createError({ statusCode: 400, statusMessage: "Cannot audit your own account" });
  }

  const [targetUser] = await db
    .select({ id: user.id, name: user.name, email: user.email, image: user.image })
    .from(user)
    .where(eq(user.id, input.userId))
    .limit(1);

  if (!targetUser) throw createError({ statusCode: 404, statusMessage: "User not found" });

  setAuditUserCookie(c, targetUser.id);

  return { success: true, data: { user: targetUser } } as const;

}

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
