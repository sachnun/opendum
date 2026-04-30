import { initiateDeviceAuth, initiateDeviceAuthInputSchema } from "../../../services/accounts";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  await requireUserId(event);
  return initiateDeviceAuth(await readDashboardBody(event, initiateDeviceAuthInputSchema));
});
