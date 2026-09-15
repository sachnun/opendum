import { getAccountsByProviderDetailed, providerDetailInputSchema } from "../../../services/accounts";
import { parseQuery, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAccountsByProviderDetailed(await requireReadableUserId(event), parseQuery(event, providerDetailInputSchema)));
