import { upsertCustomModels, upsertCustomModelsSchema } from "../../../services/custom-providers";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const input = await parseBody(event, upsertCustomModelsSchema);
  return upsertCustomModels(await requireWritableUserId(event), input.slug, input.models);
});
