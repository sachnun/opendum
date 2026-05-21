import { setHeader } from "h3";

import { apiKeyIdInputSchema, revealApiKey } from "../../../services/api-keys";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  setHeader(event, "Cache-Control", "no-store");
  const input = await readDashboardBody(event, apiKeyIdInputSchema);
  return revealApiKey(await requireWritableUserId(event), input.id);
});
