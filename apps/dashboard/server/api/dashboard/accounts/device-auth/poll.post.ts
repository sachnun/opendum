import { pollDeviceAuth, pollDeviceAuthInputSchema } from "../../../../services/account-auth";
import { readDashboardBody, requireWritableUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => pollDeviceAuth(await requireWritableUserId(event), await readDashboardBody(event, pollDeviceAuthInputSchema)));
