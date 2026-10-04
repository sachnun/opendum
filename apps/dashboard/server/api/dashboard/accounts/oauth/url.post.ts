import { getAccountAuthUrl, getAuthUrlInputSchema } from "~~/server/services/account-auth";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => {
  await requireWritableUserId(event);
  return getAccountAuthUrl(await parseBody(event, getAuthUrlInputSchema));
});
