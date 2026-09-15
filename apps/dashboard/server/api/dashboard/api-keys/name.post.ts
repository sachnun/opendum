import { updateApiKeyName, updateApiKeyNameInputSchema } from "../../../services/api-keys";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateApiKeyName(await requireWritableUserId(event), await parseBody(event, updateApiKeyNameInputSchema)));
