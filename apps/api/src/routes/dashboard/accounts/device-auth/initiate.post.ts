import { initiateDeviceAuth, initiateDeviceAuthInputSchema } from "../../../../services/account-auth";
import { readDashboardBody, requireWritableUserId } from "../../../../utils/api";

import type { Context } from "hono";
export async function handler(c: Context) {

  await requireWritableUserId(c);
  return initiateDeviceAuth(await readDashboardBody(c, initiateDeviceAuthInputSchema));

}

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
