import { updateApiKeyRoaming, updateApiKeyRoamingInputSchema } from "~~/server/services/api-keys";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => {
  const input = await parseBody(event, updateApiKeyRoamingInputSchema);
  return updateApiKeyRoaming(await requireWritableUserId(event), input);
});
