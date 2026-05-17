import { z } from "zod";

import { setUserSharingEnabled } from "../../../services/sharing";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

const sharingInputSchema = z.object({ enabled: z.boolean() });

export default defineEventHandler(async (event) => {
  const input = await readDashboardBody(event, sharingInputSchema);
  return setUserSharingEnabled(await requireWritableUserId(event), input.enabled);
});
