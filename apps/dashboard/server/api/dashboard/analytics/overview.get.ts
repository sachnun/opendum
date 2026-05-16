import { getAnalyticsOverview } from "../../../services/analytics";
import { requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAnalyticsOverview(await requireReadableUserId(event)));
