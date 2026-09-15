import { z } from "zod";

import { setUserSharingEnabled } from "../../../services/sharing";
import { parseBody, requireWritableUserId } from "../../../utils/api";

const sharingInputSchema = z.object({ enabled: z.boolean() });

export default defineEventHandler(async (event) => {
  const input = await parseBody(event, sharingInputSchema);
  return setUserSharingEnabled(await requireWritableUserId(event), input.enabled);
});
