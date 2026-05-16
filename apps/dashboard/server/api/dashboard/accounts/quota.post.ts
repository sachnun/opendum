import { accountQuotaInputSchema, getAccountQuota } from "../../../services/account-quota";
import { readDashboardBody, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAccountQuota(await requireReadableUserId(event), await readDashboardBody(event, accountQuotaInputSchema)));
