import { clearAuditUserCookie, requireMaintenerContext } from "../../../../utils/api";

import type { Context } from "hono";
export async function handler(c: Context) {

  await requireMaintenerContext(c);
  clearAuditUserCookie(c);

  return { success: true, data: undefined } as const;

}

import { Hono } from "hono";

const app = new Hono();
app.post("/", async (c) => c.json(await handler(c)));
export default app;
