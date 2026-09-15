import { getModelStats, modelStatsInputSchema } from "../../../services/models";
import { parseQuery, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getModelStats(await requireReadableUserId(event), parseQuery(event, modelStatsInputSchema)));
