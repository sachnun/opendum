import { createError } from "h3";
import { accountSessionInputSchema, getAccountSession } from "../../../services/accounts";
import { parseBody, requireContext } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const context = await requireContext(event);
  if (process.env.NODE_ENV === "production" && !context.isMaintainer) {
    throw createError({ statusCode: 404, statusMessage: "Not Found" });
  }
  if (context.isAuditMode) {
    throw createError({ statusCode: 403, statusMessage: "Audit mode is read-only" });
  }

  return getAccountSession(context.userId, await parseBody(event, accountSessionInputSchema));
});
