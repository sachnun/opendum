import { updateApiKeyName, updateApiKeyNameInputSchema } from "../../../services/api-keys";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

import type { Context } from "hono";
export const handler = async (c: Context) => updateApiKeyName(await requireWritableUserId(c), await readDashboardBody(c, updateApiKeyNameInputSchema));

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
