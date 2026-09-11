import { syncCustomModels, syncCustomModelsSchema } from "../../../services/custom-providers";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const input = await readDashboardBody(event, syncCustomModelsSchema);
  return syncCustomModels(await requireWritableUserId(event), input.slug);
});
