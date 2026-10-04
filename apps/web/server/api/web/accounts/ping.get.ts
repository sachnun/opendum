import { getAccountPing } from "~~/server/services/accounts";
import { requireReadContext } from "~~/server/utils/api";

export default defineEventHandler(async (event) => {
  const context = await requireReadContext(event);
  return getAccountPing(context.userId, { autoPin: !context.isAuditMode });
});
