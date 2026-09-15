import { listAccountsByProvider, providerInputSchema } from "../../../services/accounts";
import { parseQuery, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => listAccountsByProvider(await requireReadableUserId(event), parseQuery(event, providerInputSchema)));
