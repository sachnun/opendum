import { z } from "zod";

import { setUserSharingEnabled } from "../../../services/sharing";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

const sharingInputSchema = z.object({ enabled: z.boolean() });

import type { Context } from "hono";
export async function handler(c: Context) {

  const input = await readDashboardBody(c, sharingInputSchema);
  return setUserSharingEnabled(await requireWritableUserId(c), input.enabled);

}

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
