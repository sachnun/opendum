import { analyticsByApiKeyInputSchema, getAnalyticsByApiKey } from "../../../services/analytics";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAnalyticsByApiKey(await requireUserId(event), await readDashboardBody(event, analyticsByApiKeyInputSchema)));
