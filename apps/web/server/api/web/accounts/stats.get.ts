import { accountStatsInputSchema, getAccountStats } from "~~/server/services/accounts";
import { parseQuery, requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => getAccountStats(await requireReadableUserId(event), parseQuery(event, accountStatsInputSchema)));
