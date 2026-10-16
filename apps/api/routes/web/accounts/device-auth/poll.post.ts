import { defineHandler } from "nitro";
import { pollDeviceAuth, pollDeviceAuthInputSchema } from "#web/services/account-auth.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => pollDeviceAuth(await requireWritableUserId(event), await parseBody(event, pollDeviceAuthInputSchema)));
