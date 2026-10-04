import { updateApiKeyRateLimits, updateApiKeyRateLimitsInputSchema } from "~~/server/services/api-keys";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => updateApiKeyRateLimits(await requireWritableUserId(event), await parseBody(event, updateApiKeyRateLimitsInputSchema)));
