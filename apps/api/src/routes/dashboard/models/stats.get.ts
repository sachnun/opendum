import { getModelStats, modelStatsInputSchema } from "../../../services/models";
import { getDashboardQuery, requireReadableUserId } from "../../../utils/api";

import type { Context } from "hono";
export const handler = async (c: Context) => getModelStats(await requireReadableUserId(c), getDashboardQuery(c, modelStatsInputSchema));

import { Hono } from "hono";

const app = new Hono();
app.get("/", async (c) => c.json(await handler(c)));
export default app;
