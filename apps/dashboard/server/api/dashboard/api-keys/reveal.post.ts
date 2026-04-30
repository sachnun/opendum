import { apiKeyIdInputSchema, revealApiKey } from "../../../services/api-keys";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const input = await readDashboardBody(event, apiKeyIdInputSchema);
  return revealApiKey(await requireUserId(event), input.id);
});
