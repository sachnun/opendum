import { getAccountAuthUrl, getAuthUrlInputSchema } from "../../../../services/account-auth";
import { parseBody, requireWritableUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => {
  await requireWritableUserId(event);
  return getAccountAuthUrl(await parseBody(event, getAuthUrlInputSchema));
});
