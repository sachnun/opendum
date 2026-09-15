import { updateApiKeyAccountAccess, updateApiKeyAccountAccessInputSchema } from "../../../services/api-keys";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateApiKeyAccountAccess(await requireWritableUserId(event), await parseBody(event, updateApiKeyAccountAccessInputSchema)));
