import { apiKeyIdInputSchema, toggleApiKey } from "../../../services/api-keys";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const input = await readDashboardBody(event, apiKeyIdInputSchema);
  return toggleApiKey(await requireUserId(event), input.id);
});
