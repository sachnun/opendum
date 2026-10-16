import { defineHandler } from "nitro";
import { updateApiKeyExpiration, updateApiKeyExpirationInputSchema } from "#web/services/api-keys.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => updateApiKeyExpiration(await requireWritableUserId(event), await parseBody(event, updateApiKeyExpirationInputSchema)));
