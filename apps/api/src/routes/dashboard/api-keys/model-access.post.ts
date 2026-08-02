import { updateApiKeyModelAccess, updateApiKeyModelAccessInputSchema } from "../../../services/api-keys";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

import type { Context } from "hono";
export const handler = async (c: Context) => updateApiKeyModelAccess(await requireWritableUserId(c), await readDashboardBody(c, updateApiKeyModelAccessInputSchema));

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
