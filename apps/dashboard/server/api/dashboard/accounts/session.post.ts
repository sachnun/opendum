import { createError } from "h3";
import { accountSessionInputSchema, getAccountSession } from "../../../services/accounts";
import { readDashboardBody, requireDashboardContext } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const context = await requireDashboardContext(event);
  if (process.env.NODE_ENV === "production" && !context.isMaintener) {
    throw createError({ statusCode: 404, statusMessage: "Not Found" });
  }
  if (context.isAuditMode) {
    throw createError({ statusCode: 403, statusMessage: "Audit mode is read-only" });
  }

  return getAccountSession(context.userId, await readDashboardBody(event, accountSessionInputSchema));
});
