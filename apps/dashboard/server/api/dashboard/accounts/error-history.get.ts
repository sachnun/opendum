import { errorHistoryInputSchema, getAccountErrorHistory } from "../../../services/accounts";
import { getDashboardQuery, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAccountErrorHistory(await requireUserId(event), getDashboardQuery(event, errorHistoryInputSchema)));
