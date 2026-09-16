import { clearAuditUserCookie, requireMaintainerContext } from "../../../../utils/api";

export default defineEventHandler(async (event) => {
  await requireMaintainerContext(event);
  clearAuditUserCookie(event);

  return { success: true, data: undefined } as const;
});
