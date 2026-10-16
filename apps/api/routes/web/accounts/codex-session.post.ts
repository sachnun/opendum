import { defineHandler } from "nitro";
import { connectCodexSessionAccount, connectCodexSessionInputSchema } from "#web/services/account-auth.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => connectCodexSessionAccount(await requireWritableUserId(event), await parseBody(event, connectCodexSessionInputSchema)));
