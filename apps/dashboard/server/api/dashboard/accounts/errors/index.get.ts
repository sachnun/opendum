import { errorHistoryInputSchema, getAccountErrorHistory } from "../../../../services/accounts";
import { parseQuery, requireReadableUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => getAccountErrorHistory(await requireReadableUserId(event), parseQuery(event, errorHistoryInputSchema)));
