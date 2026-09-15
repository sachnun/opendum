import { deleteAccount, deleteAccountInputSchema } from "../../../services/accounts";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => deleteAccount(await requireWritableUserId(event), await parseBody(event, deleteAccountInputSchema)));
