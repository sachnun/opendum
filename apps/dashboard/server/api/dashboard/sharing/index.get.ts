import { getUserSharingEnabled } from "../../../services/sharing";
import { requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => ({
  enabled: await getUserSharingEnabled(await requireReadableUserId(event)),
}));
