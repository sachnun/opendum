import { clearAuditUserCookie, requireMaintenerContext } from "../../../../utils/api";

export default defineEventHandler(async (event) => {
  await requireMaintenerContext(event);
  clearAuditUserCookie(event);

  return { success: true, data: undefined } as const;
});
