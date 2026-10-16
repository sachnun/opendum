import { defineHandler } from "nitro";
import { accountQuotaBatchInputSchema, getAccountQuotas } from "#web/services/account-quota.js";
import { parseBody, requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => getAccountQuotas(await requireReadableUserId(event), await parseBody(event, accountQuotaBatchInputSchema)));
