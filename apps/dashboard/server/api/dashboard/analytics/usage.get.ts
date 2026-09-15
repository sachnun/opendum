import { analyticsUsageInputSchema, getUsageRows } from "../../../services/analytics";
import { parseQuery, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getUsageRows(await requireReadableUserId(event), parseQuery(event, analyticsUsageInputSchema)));
