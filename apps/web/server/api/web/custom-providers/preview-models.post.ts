import { previewCustomModels, previewCustomModelsSchema } from "~~/server/services/custom-providers";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => {
  await requireWritableUserId(event);
  return previewCustomModels(await parseBody(event, previewCustomModelsSchema));
});
