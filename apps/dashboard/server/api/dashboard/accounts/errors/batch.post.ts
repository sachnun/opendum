import { errorHistoryBatchInputSchema, getAccountErrorHistories } from "../../../../services/accounts";
import { readDashboardBody, requireReadableUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => getAccountErrorHistories(await requireReadableUserId(event), await readDashboardBody(event, errorHistoryBatchInputSchema)));
