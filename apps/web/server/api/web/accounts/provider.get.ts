import { listAccountsByProvider, providerInputSchema } from "~~/server/services/accounts";
import { parseQuery, requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => listAccountsByProvider(await requireReadableUserId(event), parseQuery(event, providerInputSchema)));
