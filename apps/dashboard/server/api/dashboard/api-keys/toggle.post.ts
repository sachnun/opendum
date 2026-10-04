import { apiKeyIdInputSchema, toggleApiKey } from "~~/server/services/api-keys";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => {
  const input = await parseBody(event, apiKeyIdInputSchema);
  return toggleApiKey(await requireWritableUserId(event), input.id);
});
