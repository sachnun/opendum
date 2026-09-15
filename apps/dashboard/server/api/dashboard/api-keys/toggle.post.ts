import { apiKeyIdInputSchema, toggleApiKey } from "../../../services/api-keys";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const input = await parseBody(event, apiKeyIdInputSchema);
  return toggleApiKey(await requireWritableUserId(event), input.id);
});
