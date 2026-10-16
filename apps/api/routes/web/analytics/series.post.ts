import { defineHandler } from "nitro";
import { analyticsSeriesInputSchema, getAnalyticsSeries } from "#web/services/analytics.js";
import { parseBody, requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => getAnalyticsSeries(await requireReadableUserId(event), await parseBody(event, analyticsSeriesInputSchema)));
