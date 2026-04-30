import { exchangeOAuthAccount, exchangeOAuthInputSchema } from "../../../services/accounts";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => exchangeOAuthAccount(await requireUserId(event), await readDashboardBody(event, exchangeOAuthInputSchema)));
