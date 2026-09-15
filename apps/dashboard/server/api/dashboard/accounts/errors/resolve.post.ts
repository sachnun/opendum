import { resolveAccountErrors, resolveErrorsInputSchema } from "../../../../services/accounts";
import { parseBody, requireWritableUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => resolveAccountErrors(await requireWritableUserId(event), await parseBody(event, resolveErrorsInputSchema)));
