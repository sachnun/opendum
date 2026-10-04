import { updateApiKeyExpiration, updateApiKeyExpirationInputSchema } from "~~/server/services/api-keys";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => updateApiKeyExpiration(await requireWritableUserId(event), await parseBody(event, updateApiKeyExpirationInputSchema)));
