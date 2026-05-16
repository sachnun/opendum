import { apiKeyIdInputSchema, deleteApiKey } from "../../../services/api-keys";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const input = await readDashboardBody(event, apiKeyIdInputSchema);
  return deleteApiKey(await requireWritableUserId(event), input.id);
});
