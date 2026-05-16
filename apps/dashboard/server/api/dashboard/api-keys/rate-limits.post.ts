import { updateApiKeyRateLimits, updateApiKeyRateLimitsInputSchema } from "../../../services/api-keys";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateApiKeyRateLimits(await requireWritableUserId(event), await readDashboardBody(event, updateApiKeyRateLimitsInputSchema)));
