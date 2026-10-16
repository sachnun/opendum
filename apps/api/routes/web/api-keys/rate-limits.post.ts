import { defineHandler } from "nitro";
import { updateApiKeyRateLimits, updateApiKeyRateLimitsInputSchema } from "#web/services/api-keys.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => updateApiKeyRateLimits(await requireWritableUserId(event), await parseBody(event, updateApiKeyRateLimitsInputSchema)));
