import { createApiKey, createApiKeyInputSchema } from "../../../services/api-keys";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => createApiKey(await requireUserId(event), await readDashboardBody(event, createApiKeyInputSchema)));
