import { defineHandler } from "nitro";
import { listAccountsByProvider, providerInputSchema } from "#web/services/accounts.js";
import { parseQuery, requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => listAccountsByProvider(await requireReadableUserId(event), parseQuery(event, providerInputSchema)));
