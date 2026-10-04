import { upsertCustomModels, upsertCustomModelsSchema } from "~~/server/services/custom-providers";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => {
  const input = await parseBody(event, upsertCustomModelsSchema);
  return upsertCustomModels(await requireWritableUserId(event), input.slug, input.models);
});
