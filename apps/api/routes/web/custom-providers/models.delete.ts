import { defineHandler } from "nitro";
import { deleteCustomModel, deleteCustomModelSchema } from "#web/services/custom-providers.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  const input = await parseBody(event, deleteCustomModelSchema);
  return deleteCustomModel(await requireWritableUserId(event), input.slug, input.modelId);
});
