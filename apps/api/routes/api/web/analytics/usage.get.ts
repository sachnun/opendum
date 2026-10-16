import { defineHandler } from "nitro";
import { analyticsUsageInputSchema, getUsageRows } from "#web/services/analytics.js";
import { parseQuery, requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => getUsageRows(await requireReadableUserId(event), parseQuery(event, analyticsUsageInputSchema)));
