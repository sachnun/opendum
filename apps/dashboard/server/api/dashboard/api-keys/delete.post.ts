import { apiKeyIdInputSchema, deleteApiKey } from "../../../services/api-keys";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const input = await parseBody(event, apiKeyIdInputSchema);
  return deleteApiKey(await requireWritableUserId(event), input.id);
});
