import { connectCodexSessionAccount, connectCodexSessionInputSchema } from "~~/server/services/account-auth";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => connectCodexSessionAccount(await requireWritableUserId(event), await parseBody(event, connectCodexSessionInputSchema)));
