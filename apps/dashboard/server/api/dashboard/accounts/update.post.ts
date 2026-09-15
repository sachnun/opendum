import { updateAccount, updateAccountInputSchema } from "../../../services/accounts";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateAccount(await requireWritableUserId(event), await parseBody(event, updateAccountInputSchema)));
