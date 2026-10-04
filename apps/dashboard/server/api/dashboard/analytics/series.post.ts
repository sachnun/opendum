import { analyticsSeriesInputSchema, getAnalyticsSeries } from "~~/server/services/analytics";
import { parseBody, requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => getAnalyticsSeries(await requireReadableUserId(event), await parseBody(event, analyticsSeriesInputSchema)));
