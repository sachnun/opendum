import { deleteCustomModel, deleteCustomModelSchema } from "../../../services/custom-providers";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const input = await readDashboardBody(event, deleteCustomModelSchema);
  return deleteCustomModel(await requireWritableUserId(event), input.slug, input.modelId);
});
