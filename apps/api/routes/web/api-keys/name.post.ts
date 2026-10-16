import { defineHandler } from "nitro";
import { updateApiKeyName, updateApiKeyNameInputSchema } from "#web/services/api-keys.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => updateApiKeyName(await requireWritableUserId(event), await parseBody(event, updateApiKeyNameInputSchema)));
