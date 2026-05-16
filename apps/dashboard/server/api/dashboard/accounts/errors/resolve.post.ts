import { resolveAccountErrors, resolveErrorsInputSchema } from "../../../../services/accounts";
import { readDashboardBody, requireWritableUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => resolveAccountErrors(await requireWritableUserId(event), await readDashboardBody(event, resolveErrorsInputSchema)));
