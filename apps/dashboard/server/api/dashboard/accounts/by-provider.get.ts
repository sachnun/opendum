import { listAccountsByProvider, providerInputSchema } from "../../../services/accounts";
import { getDashboardQuery, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => listAccountsByProvider(await requireUserId(event), getDashboardQuery(event, providerInputSchema)));
