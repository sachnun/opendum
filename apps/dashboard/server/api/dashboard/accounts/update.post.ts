import { updateAccount, updateAccountInputSchema } from "../../../services/accounts";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateAccount(await requireUserId(event), await readDashboardBody(event, updateAccountInputSchema)));
