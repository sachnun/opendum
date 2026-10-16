import { defineHandler } from "nitro";
import { getModelStats, modelStatsInputSchema } from "#web/services/models.js";
import { parseQuery, requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => getModelStats(await requireReadableUserId(event), parseQuery(event, modelStatsInputSchema)));
