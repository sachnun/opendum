import { defineHandler } from "nitro";
import { updateApiKeyModelAccess, updateApiKeyModelAccessInputSchema } from "#web/services/api-keys.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => updateApiKeyModelAccess(await requireWritableUserId(event), await parseBody(event, updateApiKeyModelAccessInputSchema)));
