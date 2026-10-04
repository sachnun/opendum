import { createAccount, createAccountInputSchema } from "~~/server/services/accounts";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => createAccount(await requireWritableUserId(event), await parseBody(event, createAccountInputSchema)));
