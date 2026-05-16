import { updateApiKeyName, updateApiKeyNameInputSchema } from "../../../services/api-keys";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateApiKeyName(await requireWritableUserId(event), await readDashboardBody(event, updateApiKeyNameInputSchema)));
