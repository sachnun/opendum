import { accountQuotaInputSchema, getAccountQuota } from "../../../services/account-quota";
import { readDashboardBody, requireReadableUserId } from "../../../utils/api";

import type { Context } from "hono";
export const handler = async (c: Context) => getAccountQuota(await requireReadableUserId(c), await readDashboardBody(c, accountQuotaInputSchema));

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
