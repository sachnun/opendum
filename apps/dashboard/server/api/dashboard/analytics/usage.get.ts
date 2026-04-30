import { analyticsUsageInputSchema, getUsageRows } from "../../../services/analytics";
import { getDashboardQuery, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getUsageRows(await requireUserId(event), getDashboardQuery(event, analyticsUsageInputSchema)));
