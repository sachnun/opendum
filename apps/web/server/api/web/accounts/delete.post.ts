import { deleteAccount, deleteAccountInputSchema } from "~~/server/services/accounts";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => deleteAccount(await requireWritableUserId(event), await parseBody(event, deleteAccountInputSchema)));
