import { getPlaygroundOptions } from "../../../services/playground";
import { requireReadableUserId } from "../../../utils/api";

import type { Context } from "hono";
export async function handler(c: Context) {

  return getPlaygroundOptions(await requireReadableUserId(c), process.env.PROXY_URL || process.env.NUXT_PUBLIC_PROXY_URL || "");

}

import { Hono } from "hono";

const app = new Hono();
app.get("/", async (c) => c.json(await handler(c)));
export default app;
