import { accountQuotaBatchInputSchema, getAccountQuotas } from "../../../services/account-quota";
import { readDashboardBody, requireReadableUserId } from "../../../utils/api";

import type { Context } from "hono";
export const handler = async (c: Context) => getAccountQuotas(await requireReadableUserId(c), await readDashboardBody(c, accountQuotaBatchInputSchema));

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
