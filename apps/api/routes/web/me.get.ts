import { defineHandler } from "nitro";
import { requireContext } from "#web/utils/api.js";
import { getUserPointStatus } from "#web/services/points.js";
import { getUserSharingEnabled } from "#web/services/sharing.js";

export default defineHandler(async (event) => {
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
