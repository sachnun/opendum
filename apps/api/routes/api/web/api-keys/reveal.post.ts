import { defineHandler } from "nitro";
import { apiKeyIdInputSchema, revealApiKey } from "#web/services/api-keys.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  event.res.headers.set("Cache-Control", "no-store");
  const input = await parseBody(event, apiKeyIdInputSchema);
  return revealApiKey(await requireWritableUserId(event), input.id);
});
