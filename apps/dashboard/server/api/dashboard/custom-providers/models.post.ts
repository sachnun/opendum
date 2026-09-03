import { upsertCustomModels, upsertCustomModelsSchema } from "../../../services/custom-providers";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const input = await readDashboardBody(event, upsertCustomModelsSchema);
  return upsertCustomModels(await requireWritableUserId(event), input.slug, input.models);
});
