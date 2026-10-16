import { defineHandler } from "nitro";
import { getAnalyticsOverview } from "#web/services/analytics.js";
import { requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => getAnalyticsOverview(await requireReadableUserId(event)));
