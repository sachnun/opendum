import { analyticsDataInputSchema, getAnalyticsData } from "../../../services/analytics";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAnalyticsData(await requireUserId(event), await readDashboardBody(event, analyticsDataInputSchema)));
