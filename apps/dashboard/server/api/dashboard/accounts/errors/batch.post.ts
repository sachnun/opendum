import { errorHistoryBatchInputSchema, getAccountErrorHistories } from "../../../../services/accounts";
import { parseBody, requireReadableUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => getAccountErrorHistories(await requireReadableUserId(event), await parseBody(event, errorHistoryBatchInputSchema)));
