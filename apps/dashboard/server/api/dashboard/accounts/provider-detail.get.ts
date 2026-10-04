import { getAccountsByProviderDetailed, providerDetailInputSchema } from "~~/server/services/accounts";
import { parseQuery, requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => getAccountsByProviderDetailed(await requireReadableUserId(event), parseQuery(event, providerDetailInputSchema)));
