import { requireContext } from "~~/server/utils/api";
import { getUserPointStatus } from "~~/server/services/points";
import { getUserSharingEnabled } from "~~/server/services/sharing";

export default defineEventHandler(async (event) => {
  const context = await requireContext(event);
  const [pointStatus, sharingEnabled] = await Promise.all([
    getUserPointStatus(context.userId),
    getUserSharingEnabled(context.userId),
  ]);

  return {
    role: context.role,
    isMaintainer: context.isMaintainer,
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
