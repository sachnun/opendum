import { analyticsDataInputSchema, getAnalyticsData } from "../../../services/analytics";
import { readDashboardBody, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAnalyticsData(await requireReadableUserId(event), await readDashboardBody(event, analyticsDataInputSchema)));
