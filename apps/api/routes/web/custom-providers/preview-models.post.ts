import { defineHandler } from "nitro";
import { previewCustomModels, previewCustomModelsSchema } from "#web/services/custom-providers.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  await requireWritableUserId(event);
  return previewCustomModels(await parseBody(event, previewCustomModelsSchema));
});
