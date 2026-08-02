import { accountOverviewInputSchema, getAccountOverview } from "../../../services/accounts";
import { getDashboardQuery, requireReadableDashboardContext } from "../../../utils/api";

import type { Context } from "hono";
export async function handler(c: Context) {

  const context = await requireReadableDashboardContext(c);
  const query = getDashboardQuery(c, accountOverviewInputSchema);
  return getAccountOverview(context.userId, { autoPin: !context.isAuditMode, cursor: query.cursor });

}

import { Hono } from "hono";

const app = new Hono();
app.get("/", async (c) => c.json(await handler(c)));
export default app;
