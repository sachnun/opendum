import { accountQuotaInputSchema, getAccountQuota } from "../../../services/account-quota";
import { parseBody, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAccountQuota(await requireReadableUserId(event), await parseBody(event, accountQuotaInputSchema)));
