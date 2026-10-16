import { defineHandler } from "nitro";
import { errorHistoryInputSchema, getAccountErrorHistory } from "#web/services/accounts.js";
import { parseQuery, requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => getAccountErrorHistory(await requireReadableUserId(event), parseQuery(event, errorHistoryInputSchema)));
