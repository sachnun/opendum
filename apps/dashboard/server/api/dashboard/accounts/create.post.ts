import { createAccount, createAccountInputSchema } from "../../../services/accounts";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => createAccount(await requireWritableUserId(event), await parseBody(event, createAccountInputSchema)));
