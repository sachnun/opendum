import { analyticsByApiKeyInputSchema, getAnalyticsByApiKey } from "../../../services/analytics";
import { readDashboardBody, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAnalyticsByApiKey(await requireReadableUserId(event), await readDashboardBody(event, analyticsByApiKeyInputSchema)));
