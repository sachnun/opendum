import { defineHandler } from "nitro";
import { apiKeyIdInputSchema, toggleApiKey } from "#web/services/api-keys.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  const input = await parseBody(event, apiKeyIdInputSchema);
  return toggleApiKey(await requireWritableUserId(event), input.id);
});
