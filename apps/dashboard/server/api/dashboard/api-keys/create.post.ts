import { createApiKey, createApiKeyInputSchema } from "../../../services/api-keys";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => createApiKey(await requireWritableUserId(event), await parseBody(event, createApiKeyInputSchema)));
