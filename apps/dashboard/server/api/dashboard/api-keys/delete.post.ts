import { apiKeyIdInputSchema, deleteApiKey } from "../../../services/api-keys";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const input = await readDashboardBody(event, apiKeyIdInputSchema);
  return deleteApiKey(await requireUserId(event), input.id);
});
