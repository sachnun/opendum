import { defineHandler } from "nitro";
import { connectCustomProviderAccount, connectCustomProviderAccountSchema } from "#web/services/custom-providers.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  const input = await parseBody(event, connectCustomProviderAccountSchema);
  return connectCustomProviderAccount(await requireWritableUserId(event), input.slug, input.token, input.name);
});
