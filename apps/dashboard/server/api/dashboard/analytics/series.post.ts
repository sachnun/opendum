import { analyticsSeriesInputSchema, getAnalyticsSeries } from "../../../services/analytics";
import { readDashboardBody, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAnalyticsSeries(await requireReadableUserId(event), await readDashboardBody(event, analyticsSeriesInputSchema)));
