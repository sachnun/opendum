import { togglePinnedProvider, togglePinnedProviderInputSchema } from "../../../services/accounts";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

import type { Context } from "hono";
export const handler = async (c: Context) => togglePinnedProvider(await requireWritableUserId(c), await readDashboardBody(c, togglePinnedProviderInputSchema));

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
