import { updateApiKeyExpiration, updateApiKeyExpirationInputSchema } from "../../../services/api-keys";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateApiKeyExpiration(await requireWritableUserId(event), await parseBody(event, updateApiKeyExpirationInputSchema)));
