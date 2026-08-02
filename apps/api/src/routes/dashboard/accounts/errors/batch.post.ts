import { errorHistoryBatchInputSchema, getAccountErrorHistories } from "../../../../services/accounts";
import { readDashboardBody, requireReadableUserId } from "../../../../utils/api";

import type { Context } from "hono";
export const handler = async (c: Context) => getAccountErrorHistories(await requireReadableUserId(c), await readDashboardBody(c, errorHistoryBatchInputSchema));

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
