import { deleteCustomModel, deleteCustomModelSchema } from "../../../services/custom-providers";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const input = await parseBody(event, deleteCustomModelSchema);
  return deleteCustomModel(await requireWritableUserId(event), input.slug, input.modelId);
});
