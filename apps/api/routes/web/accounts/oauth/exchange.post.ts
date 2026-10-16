import { defineHandler } from "nitro";
import { exchangeOAuthAccount, exchangeOAuthInputSchema } from "#web/services/account-auth.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => exchangeOAuthAccount(await requireWritableUserId(event), await parseBody(event, exchangeOAuthInputSchema)));
