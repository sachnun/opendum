import { analyticsUsageInputSchema, getUsageRows } from "../../../services/analytics";
import { getDashboardQuery, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getUsageRows(await requireReadableUserId(event), getDashboardQuery(event, analyticsUsageInputSchema)));
