import { defineHandler } from "nitro";
import { errorHistoryBatchInputSchema, getAccountErrorHistories } from "#web/services/accounts.js";
import { parseBody, requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => getAccountErrorHistories(await requireReadableUserId(event), await parseBody(event, errorHistoryBatchInputSchema)));
