import { z } from "zod";

import { listModels } from "../../../services/models";
import { getDashboardQuery, requireReadableUserId } from "../../../utils/api";

const modelsQuerySchema = z.object({
  includeStats: z.union([z.literal("true"), z.literal("false"), z.boolean()]).optional(),
});

export default defineEventHandler(async (event) => {
  const query = getDashboardQuery(event, modelsQuerySchema);
  return listModels(await requireReadableUserId(event), { includeStats: query.includeStats !== "false" && query.includeStats !== false });
});
