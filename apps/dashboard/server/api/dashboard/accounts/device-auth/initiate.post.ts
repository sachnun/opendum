import { initiateDeviceAuth, initiateDeviceAuthInputSchema } from "../../../../services/account-auth";
import { readDashboardBody, requireWritableUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => {
  await requireWritableUserId(event);
  return initiateDeviceAuth(await readDashboardBody(event, initiateDeviceAuthInputSchema));
});
