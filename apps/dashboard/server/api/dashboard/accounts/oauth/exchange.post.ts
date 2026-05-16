import { exchangeOAuthAccount, exchangeOAuthInputSchema } from "../../../../services/account-auth";
import { readDashboardBody, requireWritableUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => exchangeOAuthAccount(await requireWritableUserId(event), await readDashboardBody(event, exchangeOAuthInputSchema)));
