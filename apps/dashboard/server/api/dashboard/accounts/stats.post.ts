import { accountStatsInputSchema, getAccountStats } from "../../../services/accounts";
import { readDashboardBody, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAccountStats(await requireReadableUserId(event), await readDashboardBody(event, accountStatsInputSchema)));
