import { pollDeviceAuth, pollDeviceAuthInputSchema } from "../../../../services/account-auth";
import { readDashboardBody, requireUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => pollDeviceAuth(await requireUserId(event), await readDashboardBody(event, pollDeviceAuthInputSchema)));
