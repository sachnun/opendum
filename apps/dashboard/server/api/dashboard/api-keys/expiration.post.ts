import { updateApiKeyExpiration, updateApiKeyExpirationInputSchema } from "../../../services/api-keys";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateApiKeyExpiration(await requireUserId(event), await readDashboardBody(event, updateApiKeyExpirationInputSchema)));
