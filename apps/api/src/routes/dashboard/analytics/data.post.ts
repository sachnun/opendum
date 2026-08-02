import { analyticsDataInputSchema, getAnalyticsData } from "../../../services/analytics";
import { readDashboardBody, requireReadableUserId } from "../../../utils/api";

import type { Context } from "hono";
export const handler = async (c: Context) => getAnalyticsData(await requireReadableUserId(c), await readDashboardBody(c, analyticsDataInputSchema));

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
