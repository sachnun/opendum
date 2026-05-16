import { getAccountsByProviderDetailed, providerInputSchema } from "../../../services/accounts";
import { getDashboardQuery, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAccountsByProviderDetailed(await requireReadableUserId(event), getDashboardQuery(event, providerInputSchema)));
