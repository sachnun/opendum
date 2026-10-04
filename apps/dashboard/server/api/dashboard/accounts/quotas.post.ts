import { accountQuotaBatchInputSchema, getAccountQuotas } from "~~/server/services/account-quota";
import { parseBody, requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => getAccountQuotas(await requireReadableUserId(event), await parseBody(event, accountQuotaBatchInputSchema)));
