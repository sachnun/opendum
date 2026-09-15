import { previewCustomModels, previewCustomModelsSchema } from "../../../services/custom-providers";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  await requireWritableUserId(event);
  return previewCustomModels(await parseBody(event, previewCustomModelsSchema));
});
