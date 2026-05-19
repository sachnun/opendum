import { getModelStats, modelStatsInputSchema } from "../../../services/models";
import { readDashboardBody, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const body = await readDashboardBody(event, modelStatsInputSchema);
  return getModelStats(await requireReadableUserId(event), body);
});
