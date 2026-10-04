import { analyticsDataInputSchema, getAnalyticsData } from "~~/server/services/analytics";
import { parseBody, requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => getAnalyticsData(await requireReadableUserId(event), await parseBody(event, analyticsDataInputSchema)));
