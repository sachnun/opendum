import { connectCustomProviderAccount, connectCustomProviderAccountSchema } from "~~/server/services/custom-providers";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => {
  const input = await parseBody(event, connectCustomProviderAccountSchema);
  return connectCustomProviderAccount(await requireWritableUserId(event), input.slug, input.token, input.name);
});
