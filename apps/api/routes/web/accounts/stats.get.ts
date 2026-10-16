import { defineHandler } from "nitro";
import { accountStatsInputSchema, getAccountStats } from "#web/services/accounts.js";
import { parseQuery, requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => getAccountStats(await requireReadableUserId(event), parseQuery(event, accountStatsInputSchema)));
