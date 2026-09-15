import { accountOverviewInputSchema, getAccountOverview } from "../../../services/accounts";
import { parseQuery, requireReadContext } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const context = await requireReadContext(event);
  const query = parseQuery(event, accountOverviewInputSchema);
  return getAccountOverview(context.userId, { autoPin: !context.isAuditMode, cursor: query.cursor });
});
