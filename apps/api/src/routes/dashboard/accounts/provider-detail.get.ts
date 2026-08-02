import { getAccountsByProviderDetailed, providerDetailInputSchema } from "../../../services/accounts";
import { getDashboardQuery, requireReadableUserId } from "../../../utils/api";

import type { Context } from "hono";
export const handler = async (c: Context) => getAccountsByProviderDetailed(await requireReadableUserId(c), getDashboardQuery(c, providerDetailInputSchema));

import { Hono } from "hono";

const app = new Hono();
app.get("/", async (c) => c.json(await handler(c)));
export default app;
