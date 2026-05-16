import { initiateDeviceAuth, initiateDeviceAuthInputSchema } from "../../../../services/account-auth";
import { readDashboardBody, requireUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => {
  await requireUserId(event);
  return initiateDeviceAuth(await readDashboardBody(event, initiateDeviceAuthInputSchema));
});
