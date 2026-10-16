import { defineHandler } from "nitro";
import { z } from "zod";

import { listModels } from "#web/services/models.js";
import { parseQuery, requireReadableUserId } from "#web/utils/api.js";

const modelsQuerySchema = z.object({
  includeStats: z.union([z.literal("true"), z.literal("false"), z.boolean()]).optional(),
});

export default defineHandler(async (event) => {
  const query = parseQuery(event, modelsQuerySchema);
  return listModels(await requireReadableUserId(event), { includeStats: query.includeStats !== "false" && query.includeStats !== false });
});
