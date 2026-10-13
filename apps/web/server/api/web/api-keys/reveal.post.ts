import { apiKeyIdInputSchema, revealApiKey } from "~~/server/services/api-keys";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => {
  event.res.headers.set("Cache-Control", "no-store");
  const input = await parseBody(event, apiKeyIdInputSchema);
  return revealApiKey(await requireWritableUserId(event), input.id);
});
