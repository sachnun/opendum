import { updateApiKeyAccountAccess, updateApiKeyAccountAccessInputSchema } from "~~/server/services/api-keys";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => updateApiKeyAccountAccess(await requireWritableUserId(event), await parseBody(event, updateApiKeyAccountAccessInputSchema)));
