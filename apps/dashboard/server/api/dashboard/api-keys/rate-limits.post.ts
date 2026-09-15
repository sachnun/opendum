import { updateApiKeyRateLimits, updateApiKeyRateLimitsInputSchema } from "../../../services/api-keys";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateApiKeyRateLimits(await requireWritableUserId(event), await parseBody(event, updateApiKeyRateLimitsInputSchema)));
