import { requireDashboardContext } from "../../utils/api";

export default defineEventHandler(async (event) => {
  const context = await requireDashboardContext(event);

  return {
    role: context.role,
    isMaintener: context.isMaintener,
    actor: context.actor,
    audit: {
      active: context.isAuditMode,
      readonly: context.isAuditMode,
      user: context.auditUser,
    },
  };
});
