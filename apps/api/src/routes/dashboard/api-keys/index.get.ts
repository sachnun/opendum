import { listApiKeys } from "../../../services/api-keys";
import { requireReadableDashboardContext } from "../../../utils/api";

import type { Context } from "hono";
export async function handler(c: Context) {

  const context = await requireReadableDashboardContext(c);
  return listApiKeys(context.userId, { expireActiveKeys: !context.isAuditMode });

}

import { Hono } from "hono";

const app = new Hono();
app.get("/", async (c) => c.json(await handler(c)));
export default app;
