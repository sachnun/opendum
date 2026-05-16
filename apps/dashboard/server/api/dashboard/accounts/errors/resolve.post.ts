import { resolveAccountErrors, resolveErrorsInputSchema } from "../../../../services/accounts";
import { readDashboardBody, requireReadableUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => resolveAccountErrors(await requireReadableUserId(event), await readDashboardBody(event, resolveErrorsInputSchema)));
