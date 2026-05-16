import { createApiKey, createApiKeyInputSchema } from "../../../services/api-keys";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => createApiKey(await requireWritableUserId(event), await readDashboardBody(event, createApiKeyInputSchema)));
