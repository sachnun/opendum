import { resolveAccountErrors, resolveErrorsInputSchema } from "../../../../services/accounts";
import { parseBody, requireAuditWritableUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => resolveAccountErrors(await requireAuditWritableUserId(event), await parseBody(event, resolveErrorsInputSchema)));
