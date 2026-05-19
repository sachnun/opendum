import { getAccountsByProviderDetailed, providerDetailInputSchema } from "../../../services/accounts";
import { getDashboardQuery, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAccountsByProviderDetailed(await requireReadableUserId(event), getDashboardQuery(event, providerDetailInputSchema)));
