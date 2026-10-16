import { defineHandler } from "nitro";
import { apiKeyIdInputSchema, deleteApiKey } from "#web/services/api-keys.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  const input = await parseBody(event, apiKeyIdInputSchema);
  return deleteApiKey(await requireWritableUserId(event), input.id);
});
