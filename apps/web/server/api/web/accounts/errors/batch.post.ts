import { errorHistoryBatchInputSchema, getAccountErrorHistories } from "~~/server/services/accounts";
import { parseBody, requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => getAccountErrorHistories(await requireReadableUserId(event), await parseBody(event, errorHistoryBatchInputSchema)));
