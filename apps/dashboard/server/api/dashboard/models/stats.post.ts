import { z } from "zod";

import { getModelStats } from "../../../services/models";
import { readDashboardBody, requireReadableUserId } from "../../../utils/api";

const modelStatsInputSchema = z.object({
  models: z.array(z.string().min(1)).max(50),
});

export default defineEventHandler(async (event) => {
  const body = await readDashboardBody(event, modelStatsInputSchema);
  return getModelStats(await requireReadableUserId(event), body.models);
});
