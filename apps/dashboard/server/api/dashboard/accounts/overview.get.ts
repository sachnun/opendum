import { accountOverviewInputSchema, getAccountOverview } from "~~/server/services/accounts";
import { parseQuery, requireReadContext } from "~~/server/utils/api";

export default defineEventHandler(async (event) => {
  const context = await requireReadContext(event);
  const query = parseQuery(event, accountOverviewInputSchema);
  return getAccountOverview(context.userId, { autoPin: !context.isAuditMode, cursor: query.cursor });
});
