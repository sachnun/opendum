import { getAnalyticsOverview } from "~~/server/services/analytics";
import { requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => getAnalyticsOverview(await requireReadableUserId(event)));
