import { getAccountAuthUrl, getAuthUrlInputSchema } from "../../../../services/account-auth";
import { readDashboardBody, requireWritableUserId } from "../../../../utils/api";

import type { Context } from "hono";
export async function handler(c: Context) {

  await requireWritableUserId(c);
  return getAccountAuthUrl(await readDashboardBody(c, getAuthUrlInputSchema));

}

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
