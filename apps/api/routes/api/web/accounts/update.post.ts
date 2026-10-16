import { defineHandler } from "nitro";
import { updateAccount, updateAccountInputSchema } from "#web/services/accounts.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => updateAccount(await requireWritableUserId(event), await parseBody(event, updateAccountInputSchema)));
