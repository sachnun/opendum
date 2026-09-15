import { analyticsDataInputSchema, getAnalyticsData } from "../../../services/analytics";
import { parseBody, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAnalyticsData(await requireReadableUserId(event), await parseBody(event, analyticsDataInputSchema)));
