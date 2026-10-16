import { defineHandler } from "nitro";
import { initiateDeviceAuth, initiateDeviceAuthInputSchema } from "#web/services/account-auth.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  await requireWritableUserId(event);
  return initiateDeviceAuth(await parseBody(event, initiateDeviceAuthInputSchema));
});
