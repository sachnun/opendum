import { exchangeOAuthAccount, exchangeOAuthInputSchema } from "../../../../services/account-auth";
import { parseBody, requireWritableUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => exchangeOAuthAccount(await requireWritableUserId(event), await parseBody(event, exchangeOAuthInputSchema)));
