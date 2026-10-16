import { defineHandler } from "nitro";
import { resolveAccountErrors, resolveErrorsInputSchema } from "#web/services/accounts.js";
import { parseBody, requireAuditWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => resolveAccountErrors(await requireAuditWritableUserId(event), await parseBody(event, resolveErrorsInputSchema)));
