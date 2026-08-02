import { exchangeOAuthAccount, exchangeOAuthInputSchema } from "../../../../services/account-auth";
import { readDashboardBody, requireWritableUserId } from "../../../../utils/api";

import type { Context } from "hono";
export const handler = async (c: Context) => exchangeOAuthAccount(await requireWritableUserId(c), await readDashboardBody(c, exchangeOAuthInputSchema));

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
