import { updateApiKeyAccountAccess, updateApiKeyAccountAccessInputSchema } from "../../../services/api-keys";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateApiKeyAccountAccess(await requireWritableUserId(event), await readDashboardBody(event, updateApiKeyAccountAccessInputSchema)));
