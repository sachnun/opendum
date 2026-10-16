import { defineHandler } from "nitro";
import { syncCustomModels, syncCustomModelsSchema } from "#web/services/custom-providers.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  const input = await parseBody(event, syncCustomModelsSchema);
  return syncCustomModels(await requireWritableUserId(event), input.slug, input.token);
});
