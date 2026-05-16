import { getAccountPing } from "../../../services/accounts";
import { requireReadableDashboardContext } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const context = await requireReadableDashboardContext(event);
  return getAccountPing(context.userId, { autoPin: !context.isAuditMode });
});
