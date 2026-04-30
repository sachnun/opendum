import { createAccount, createAccountInputSchema } from "../../../services/accounts";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => createAccount(await requireUserId(event), await readDashboardBody(event, createAccountInputSchema)));
