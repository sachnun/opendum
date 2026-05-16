import { updateApiKeyRateLimits, updateApiKeyRateLimitsInputSchema } from "../../../services/api-keys";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateApiKeyRateLimits(await requireUserId(event), await readDashboardBody(event, updateApiKeyRateLimitsInputSchema)));
