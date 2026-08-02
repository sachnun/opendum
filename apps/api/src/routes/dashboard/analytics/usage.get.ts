import { analyticsUsageInputSchema, getUsageRows } from "../../../services/analytics";
import { getDashboardQuery, requireReadableUserId } from "../../../utils/api";

import type { Context } from "hono";
export const handler = async (c: Context) => getUsageRows(await requireReadableUserId(c), getDashboardQuery(c, analyticsUsageInputSchema));

import { Hono } from "hono";

const app = new Hono();
app.get("/", async (c) => c.json(await handler(c)));
export default app;
