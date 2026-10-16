import { defineHandler } from "nitro";
import { updateApiKeyAccountAccess, updateApiKeyAccountAccessInputSchema } from "#web/services/api-keys.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => updateApiKeyAccountAccess(await requireWritableUserId(event), await parseBody(event, updateApiKeyAccountAccessInputSchema)));
