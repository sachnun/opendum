import { defineHandler } from "nitro";
import { getAccountAuthUrl, getAuthUrlInputSchema } from "#web/services/account-auth.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  await requireWritableUserId(event);
  return getAccountAuthUrl(await parseBody(event, getAuthUrlInputSchema));
});
