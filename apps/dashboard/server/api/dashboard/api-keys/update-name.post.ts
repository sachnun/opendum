import { updateApiKeyName, updateApiKeyNameInputSchema } from "../../../services/api-keys";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateApiKeyName(await requireUserId(event), await readDashboardBody(event, updateApiKeyNameInputSchema)));
