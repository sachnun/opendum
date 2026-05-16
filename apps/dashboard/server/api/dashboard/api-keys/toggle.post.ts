import { apiKeyIdInputSchema, toggleApiKey } from "../../../services/api-keys";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const input = await readDashboardBody(event, apiKeyIdInputSchema);
  return toggleApiKey(await requireWritableUserId(event), input.id);
});
