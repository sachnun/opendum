import { pollDeviceAuth, pollDeviceAuthInputSchema } from "../../../../services/account-auth";
import { readDashboardBody, requireWritableUserId } from "../../../../utils/api";

import type { Context } from "hono";
export const handler = async (c: Context) => pollDeviceAuth(await requireWritableUserId(c), await readDashboardBody(c, pollDeviceAuthInputSchema));

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
