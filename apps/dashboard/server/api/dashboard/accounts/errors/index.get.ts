import { errorHistoryInputSchema, getAccountErrorHistory } from "../../../../services/accounts";
import { getDashboardQuery, requireReadableUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => getAccountErrorHistory(await requireReadableUserId(event), getDashboardQuery(event, errorHistoryInputSchema)));
