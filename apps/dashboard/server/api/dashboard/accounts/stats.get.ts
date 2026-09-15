import { accountStatsInputSchema, getAccountStats } from "../../../services/accounts";
import { parseQuery, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAccountStats(await requireReadableUserId(event), parseQuery(event, accountStatsInputSchema)));
