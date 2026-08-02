import { connectCodexSessionAccount, connectCodexSessionInputSchema } from "../../../services/account-auth";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

import type { Context } from "hono";
export const handler = async (c: Context) => connectCodexSessionAccount(await requireWritableUserId(c), await readDashboardBody(c, connectCodexSessionInputSchema));

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
