import { getAnalyticsOverview } from "../../../services/analytics";
import { requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAnalyticsOverview(await requireUserId(event)));
