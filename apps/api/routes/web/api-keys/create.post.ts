import { defineHandler } from "nitro";
import { createApiKey, createApiKeyInputSchema } from "#web/services/api-keys.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => createApiKey(await requireWritableUserId(event), await parseBody(event, createApiKeyInputSchema)));
