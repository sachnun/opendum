import { defineHandler } from "nitro";
import { updateApiKeyRoaming, updateApiKeyRoamingInputSchema } from "#web/services/api-keys.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  const input = await parseBody(event, updateApiKeyRoamingInputSchema);
  return updateApiKeyRoaming(await requireWritableUserId(event), input);
});
