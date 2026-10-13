import { accountSessionInputSchema, getAccountSession } from "~~/server/services/accounts";
import { parseBody, requireContext } from "~~/server/utils/api";

export default defineEventHandler(async (event) => {
  const context = await requireContext(event);
  if (process.env.NODE_ENV === "production" && !context.isMaintainer) {
    throw createError({ status: 404, statusText: "Not Found" });
  }
  if (context.isAuditMode) {
    throw createError({ status: 403, statusText: "Audit mode is read-only" });
  }

  return getAccountSession(context.userId, await parseBody(event, accountSessionInputSchema));
});
