import { requireDashboardContext } from "../../utils/api";
import { getUserPointStatus } from "../../services/points";
import { getUserSharingEnabled } from "../../services/sharing";

export default defineEventHandler(async (event) => {
  const context = await requireDashboardContext(event);
  const [pointStatus, sharingEnabled] = await Promise.all([
    getUserPointStatus(context.userId),
    getUserSharingEnabled(context.userId),
  ]);

  return {
    role: context.role,
    isMaintener: context.isMaintener,
    points: {
      balance: pointStatus.balance,
      roamingPointsByApiKeyId: pointStatus.roamingPointsByApiKeyId,
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
