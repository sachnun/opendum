import { updateApiKeyRoaming, updateApiKeyRoamingInputSchema } from "../../../services/api-keys";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const input = await parseBody(event, updateApiKeyRoamingInputSchema);
  return updateApiKeyRoaming(await requireWritableUserId(event), input);
});
