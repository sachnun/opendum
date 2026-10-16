import { defineHandler } from "nitro";
import { accountQuotaInputSchema, getAccountQuota } from "#web/services/account-quota.js";
import { parseBody, requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => getAccountQuota(await requireReadableUserId(event), await parseBody(event, accountQuotaInputSchema)));
