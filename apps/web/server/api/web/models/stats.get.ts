import { getModelStats, modelStatsInputSchema } from "~~/server/services/models";
import { parseQuery, requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => getModelStats(await requireReadableUserId(event), parseQuery(event, modelStatsInputSchema)));
