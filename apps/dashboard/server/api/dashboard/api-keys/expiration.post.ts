import { updateApiKeyExpiration, updateApiKeyExpirationInputSchema } from "../../../services/api-keys";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateApiKeyExpiration(await requireWritableUserId(event), await readDashboardBody(event, updateApiKeyExpirationInputSchema)));
