import { createApiKey, createApiKeyInputSchema } from "~~/server/services/api-keys";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => createApiKey(await requireWritableUserId(event), await parseBody(event, createApiKeyInputSchema)));
