import { defineHandler } from "nitro";
import { accountOverviewInputSchema, getAccountOverview } from "#web/services/accounts.js";
import { parseQuery, requireReadContext } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  const context = await requireReadContext(event);
  const query = parseQuery(event, accountOverviewInputSchema);
  return getAccountOverview(context.userId, { autoPin: !context.isAuditMode, cursor: query.cursor });
});
