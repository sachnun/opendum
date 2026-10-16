import { defineHandler } from "nitro";
import { upsertCustomModels, upsertCustomModelsSchema } from "#web/services/custom-providers.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  const input = await parseBody(event, upsertCustomModelsSchema);
  return upsertCustomModels(await requireWritableUserId(event), input.slug, input.models);
});
