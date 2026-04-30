import { getAccountsByProviderDetailed, providerInputSchema } from "../../../services/accounts";
import { getDashboardQuery, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAccountsByProviderDetailed(await requireUserId(event), getDashboardQuery(event, providerInputSchema)));
