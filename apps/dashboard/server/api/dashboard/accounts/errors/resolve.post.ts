import { resolveAccountErrors, resolveErrorsInputSchema } from "../../../../services/accounts";
import { readDashboardBody, requireUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => resolveAccountErrors(await requireUserId(event), await readDashboardBody(event, resolveErrorsInputSchema)));
