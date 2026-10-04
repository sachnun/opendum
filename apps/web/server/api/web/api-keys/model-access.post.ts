import { updateApiKeyModelAccess, updateApiKeyModelAccessInputSchema } from "~~/server/services/api-keys";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => updateApiKeyModelAccess(await requireWritableUserId(event), await parseBody(event, updateApiKeyModelAccessInputSchema)));
