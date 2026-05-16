import { updateApiKeyAccountAccess, updateApiKeyAccountAccessInputSchema } from "../../../services/api-keys";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateApiKeyAccountAccess(await requireUserId(event), await readDashboardBody(event, updateApiKeyAccountAccessInputSchema)));
