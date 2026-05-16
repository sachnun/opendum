import { updateApiKeyModelAccess, updateApiKeyModelAccessInputSchema } from "../../../services/api-keys";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateApiKeyModelAccess(await requireWritableUserId(event), await readDashboardBody(event, updateApiKeyModelAccessInputSchema)));
