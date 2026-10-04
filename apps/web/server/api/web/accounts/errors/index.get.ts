import { errorHistoryInputSchema, getAccountErrorHistory } from "~~/server/services/accounts";
import { parseQuery, requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => getAccountErrorHistory(await requireReadableUserId(event), parseQuery(event, errorHistoryInputSchema)));
