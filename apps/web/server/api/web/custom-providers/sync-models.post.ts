import { syncCustomModels, syncCustomModelsSchema } from "~~/server/services/custom-providers";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => {
  const input = await parseBody(event, syncCustomModelsSchema);
  return syncCustomModels(await requireWritableUserId(event), input.slug, input.token);
});
