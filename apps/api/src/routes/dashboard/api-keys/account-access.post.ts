import { updateApiKeyAccountAccess, updateApiKeyAccountAccessInputSchema } from "../../../services/api-keys";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

import type { Context } from "hono";
export const handler = async (c: Context) => updateApiKeyAccountAccess(await requireWritableUserId(c), await readDashboardBody(c, updateApiKeyAccountAccessInputSchema));

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
