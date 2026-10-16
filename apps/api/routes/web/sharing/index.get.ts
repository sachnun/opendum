import { defineHandler } from "nitro";
import { getUserSharingEnabled } from "#web/services/sharing.js";
import { requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => ({
  enabled: await getUserSharingEnabled(await requireReadableUserId(event)),
}));
