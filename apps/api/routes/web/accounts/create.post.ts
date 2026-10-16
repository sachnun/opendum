import { defineHandler } from "nitro";
import { createAccount, createAccountInputSchema } from "#web/services/accounts.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => createAccount(await requireWritableUserId(event), await parseBody(event, createAccountInputSchema)));
