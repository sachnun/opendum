import { listAccountsByProvider, providerInputSchema } from "../../../services/accounts";
import { getDashboardQuery, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => listAccountsByProvider(await requireReadableUserId(event), getDashboardQuery(event, providerInputSchema)));
