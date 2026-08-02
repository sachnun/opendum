import { getApiKeyOptions } from "../../../services/api-keys";
import { requireReadableUserId } from "../../../utils/api";

import type { Context } from "hono";
export const handler = async (c: Context) => getApiKeyOptions(await requireReadableUserId(c));

import { Hono } from "hono";

const app = new Hono();
app.get("/", async (c) => c.json(await handler(c)));
export default app;
