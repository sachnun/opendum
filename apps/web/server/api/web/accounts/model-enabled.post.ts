import { setAccountModelEnabled, setAccountModelEnabledInputSchema } from "~~/server/services/accounts";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => setAccountModelEnabled(await requireWritableUserId(event), await parseBody(event, setAccountModelEnabledInputSchema)));
