import { getAccountOverview } from "../../../services/accounts";
import { requireReadableDashboardContext } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const context = await requireReadableDashboardContext(event);
  return getAccountOverview(context.userId, { autoPin: !context.isAuditMode });
});
