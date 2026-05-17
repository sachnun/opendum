import { requireDashboardContext } from "../../utils/api";
import { ensureUserPointBalance } from "../../services/points";
import { getUserSharingEnabled } from "../../services/sharing";

export default defineEventHandler(async (event) => {
  const context = await requireDashboardContext(event);
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
});
