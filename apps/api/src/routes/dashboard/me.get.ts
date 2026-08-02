import { requireDashboardContext } from "../../utils/api";
import { ensureUserPointBalance } from "../../services/points";
import { getUserSharingEnabled } from "../../services/sharing";

import type { Context } from "hono";
export async function handler(c: Context) {

  const context = await requireDashboardContext(c);
  const [pointBalance, sharingEnabled] = await Promise.all([
    ensureUserPointBalance(context.userId),
    getUserSharingEnabled(context.userId),
  ]);

  return {
    role: context.role,
    isMaintener: context.isMaintener,
    points: {
      balance: pointBalance,
    },
    sharing: {
      enabled: sharingEnabled,
    },
    actor: context.actor,
    audit: {
      active: context.isAuditMode,
      readonly: context.isAuditMode,
      user: context.auditUser,
    },
  };

}

import { Hono } from "hono";

const app = new Hono();
app.get("/", async (c) => c.json(await handler(c)));
export default app;
