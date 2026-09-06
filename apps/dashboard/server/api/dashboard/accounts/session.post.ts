import { createError } from "h3";
import { accountSessionInputSchema, getAccountSession } from "../../../services/accounts";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  if (process.env.NODE_ENV === "production") {
    throw createError({ statusCode: 404, statusMessage: "Not Found" });
  }

  return getAccountSession(await requireWritableUserId(event), await readDashboardBody(event, accountSessionInputSchema));
});