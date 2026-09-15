import { initiateDeviceAuth, initiateDeviceAuthInputSchema } from "../../../../services/account-auth";
import { parseBody, requireWritableUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => {
  await requireWritableUserId(event);
  return initiateDeviceAuth(await parseBody(event, initiateDeviceAuthInputSchema));
});
