import { setHeader } from "h3";

import { apiKeyIdInputSchema, revealApiKey } from "../../../services/api-keys";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  setHeader(event, "Cache-Control", "no-store");
  const input = await parseBody(event, apiKeyIdInputSchema);
  return revealApiKey(await requireWritableUserId(event), input.id);
});
