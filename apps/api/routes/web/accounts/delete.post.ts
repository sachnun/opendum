import { defineHandler } from "nitro";
import { deleteAccount, deleteAccountInputSchema } from "#web/services/accounts.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => deleteAccount(await requireWritableUserId(event), await parseBody(event, deleteAccountInputSchema)));
