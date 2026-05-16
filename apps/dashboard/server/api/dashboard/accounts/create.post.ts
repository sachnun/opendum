import { createAccount, createAccountInputSchema } from "../../../services/accounts";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => createAccount(await requireWritableUserId(event), await readDashboardBody(event, createAccountInputSchema)));
