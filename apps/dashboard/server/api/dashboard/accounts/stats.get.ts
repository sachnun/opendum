import { accountStatsInputSchema, getAccountStats } from "../../../services/accounts";
import { getDashboardQuery, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAccountStats(await requireReadableUserId(event), getDashboardQuery(event, accountStatsInputSchema)));
