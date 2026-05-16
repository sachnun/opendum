import { accountQuotaBatchInputSchema, getAccountQuotas } from "../../../services/account-quota";
import { readDashboardBody, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAccountQuotas(await requireReadableUserId(event), await readDashboardBody(event, accountQuotaBatchInputSchema)));
