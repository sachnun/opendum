import { deleteAccount, deleteAccountInputSchema } from "../../../services/accounts";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => deleteAccount(await requireWritableUserId(event), await readDashboardBody(event, deleteAccountInputSchema)));
