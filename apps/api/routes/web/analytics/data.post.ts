import { defineHandler } from "nitro";
import { analyticsDataInputSchema, getAnalyticsData } from "#web/services/analytics.js";
import { parseBody, requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => getAnalyticsData(await requireReadableUserId(event), await parseBody(event, analyticsDataInputSchema)));
