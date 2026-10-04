import { accountQuotaInputSchema, getAccountQuota } from "~~/server/services/account-quota";
import { parseBody, requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => getAccountQuota(await requireReadableUserId(event), await parseBody(event, accountQuotaInputSchema)));
