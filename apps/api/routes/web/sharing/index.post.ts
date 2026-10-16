import { defineHandler } from "nitro";
import { z } from "zod";

import { setUserSharingEnabled } from "#web/services/sharing.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

const sharingInputSchema = z.object({ enabled: z.boolean() });

export default defineHandler(async (event) => {
  const input = await parseBody(event, sharingInputSchema);
  return setUserSharingEnabled(await requireWritableUserId(event), input.enabled);
});
