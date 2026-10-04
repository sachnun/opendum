import { resolveAccountErrors, resolveErrorsInputSchema } from "~~/server/services/accounts";
import { parseBody, requireAuditWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => resolveAccountErrors(await requireAuditWritableUserId(event), await parseBody(event, resolveErrorsInputSchema)));
