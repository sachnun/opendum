import { accountQuotaInputSchema, getAccountQuota } from "../../../services/account-quota";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAccountQuota(await requireUserId(event), await readDashboardBody(event, accountQuotaInputSchema)));
