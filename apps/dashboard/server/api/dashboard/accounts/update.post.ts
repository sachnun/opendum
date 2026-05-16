import { updateAccount, updateAccountInputSchema } from "../../../services/accounts";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateAccount(await requireWritableUserId(event), await readDashboardBody(event, updateAccountInputSchema)));
