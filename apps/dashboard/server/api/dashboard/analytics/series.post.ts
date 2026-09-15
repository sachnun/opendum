import { analyticsSeriesInputSchema, getAnalyticsSeries } from "../../../services/analytics";
import { parseBody, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAnalyticsSeries(await requireReadableUserId(event), await parseBody(event, analyticsSeriesInputSchema)));
