import { defineHandler } from "nitro";
import { setAccountModelEnabled, setAccountModelEnabledInputSchema } from "#web/services/accounts.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => setAccountModelEnabled(await requireWritableUserId(event), await parseBody(event, setAccountModelEnabledInputSchema)));
