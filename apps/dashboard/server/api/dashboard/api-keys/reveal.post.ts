import { setHeader } from "h3";

import { apiKeyIdInputSchema, revealApiKey } from "~~/server/services/api-keys";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => {
  setHeader(event, "Cache-Control", "no-store");
  const input = await parseBody(event, apiKeyIdInputSchema);
  return revealApiKey(await requireWritableUserId(event), input.id);
});
