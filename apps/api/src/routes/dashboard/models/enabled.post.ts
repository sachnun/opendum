import { setModelEnabled, setModelEnabledInputSchema } from "../../../services/models";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

import type { Context } from "hono";
export const handler = async (c: Context) => setModelEnabled(await requireWritableUserId(c), await readDashboardBody(c, setModelEnabledInputSchema));

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
