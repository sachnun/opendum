import { listApiKeys } from "../../../services/api-keys";
import { requireReadableDashboardContext } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const context = await requireReadableDashboardContext(event);
  return listApiKeys(context.userId, { expireActiveKeys: !context.isAuditMode });
});
