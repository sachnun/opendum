import { accountQuotaBatchInputSchema, getAccountQuotas } from "../../../services/account-quota";
import { parseBody, requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAccountQuotas(await requireReadableUserId(event), await parseBody(event, accountQuotaBatchInputSchema)));
