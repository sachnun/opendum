import { updateApiKeyModelAccess, updateApiKeyModelAccessInputSchema } from "../../../services/api-keys";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateApiKeyModelAccess(await requireUserId(event), await readDashboardBody(event, updateApiKeyModelAccessInputSchema)));
