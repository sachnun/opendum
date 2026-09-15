import { connectCodexSessionAccount, connectCodexSessionInputSchema } from "../../../services/account-auth";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => connectCodexSessionAccount(await requireWritableUserId(event), await parseBody(event, connectCodexSessionInputSchema)));
