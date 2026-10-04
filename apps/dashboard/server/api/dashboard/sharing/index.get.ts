import { getUserSharingEnabled } from "~~/server/services/sharing";
import { requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => ({
  enabled: await getUserSharingEnabled(await requireReadableUserId(event)),
}));
