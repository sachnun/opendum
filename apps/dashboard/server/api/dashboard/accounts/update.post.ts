import { updateAccount, updateAccountInputSchema } from "~~/server/services/accounts";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => updateAccount(await requireWritableUserId(event), await parseBody(event, updateAccountInputSchema)));
