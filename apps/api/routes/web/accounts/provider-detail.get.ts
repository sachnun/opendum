import { defineHandler } from "nitro";
import { getAccountsByProviderDetailed, providerDetailInputSchema } from "#web/services/accounts.js";
import { parseQuery, requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => getAccountsByProviderDetailed(await requireReadableUserId(event), parseQuery(event, providerDetailInputSchema)));
