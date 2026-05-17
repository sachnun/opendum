import { updateApiKeyRoaming, updateApiKeyRoamingInputSchema } from "../../../services/api-keys";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const input = await readDashboardBody(event, updateApiKeyRoamingInputSchema);
  return updateApiKeyRoaming(await requireWritableUserId(event), input);
});
