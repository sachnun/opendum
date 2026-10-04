import { analyticsUsageInputSchema, getUsageRows } from "~~/server/services/analytics";
import { parseQuery, requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => getUsageRows(await requireReadableUserId(event), parseQuery(event, analyticsUsageInputSchema)));
