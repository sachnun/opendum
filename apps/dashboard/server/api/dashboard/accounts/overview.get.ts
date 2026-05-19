import { accountOverviewInputSchema, getAccountOverview } from "../../../services/accounts";
import { getDashboardQuery, requireReadableDashboardContext } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const context = await requireReadableDashboardContext(event);
  const query = getDashboardQuery(event, accountOverviewInputSchema);
  return getAccountOverview(context.userId, { autoPin: !context.isAuditMode, cursor: query.cursor });
});
