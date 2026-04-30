import { deleteAccount, deleteAccountInputSchema } from "../../../services/accounts";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => deleteAccount(await requireUserId(event), await readDashboardBody(event, deleteAccountInputSchema)));
