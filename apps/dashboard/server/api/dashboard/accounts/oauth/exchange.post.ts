import { exchangeOAuthAccount, exchangeOAuthInputSchema } from "~~/server/services/account-auth";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => exchangeOAuthAccount(await requireWritableUserId(event), await parseBody(event, exchangeOAuthInputSchema)));
