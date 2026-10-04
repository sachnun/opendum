import { apiKeyIdInputSchema, deleteApiKey } from "~~/server/services/api-keys";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => {
  const input = await parseBody(event, apiKeyIdInputSchema);
  return deleteApiKey(await requireWritableUserId(event), input.id);
});
