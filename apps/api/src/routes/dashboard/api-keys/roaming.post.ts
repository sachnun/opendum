import { updateApiKeyRoaming, updateApiKeyRoamingInputSchema } from "../../../services/api-keys";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

import type { Context } from "hono";
export async function handler(c: Context) {

  const input = await readDashboardBody(c, updateApiKeyRoamingInputSchema);
  return updateApiKeyRoaming(await requireWritableUserId(c), input);

}

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
