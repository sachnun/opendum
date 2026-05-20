import { getModelStats, modelStatsInputSchema } from "../../../services/models";
import { getDashboardQuery, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getModelStats(await requireReadableUserId(event), getDashboardQuery(event, modelStatsInputSchema)));
