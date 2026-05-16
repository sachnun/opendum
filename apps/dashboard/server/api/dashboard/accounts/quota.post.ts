import { accountQuotaInputSchema, getAccountQuota } from "../../../services/account-quota";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAccountQuota(await requireWritableUserId(event), await readDashboardBody(event, accountQuotaInputSchema)));
