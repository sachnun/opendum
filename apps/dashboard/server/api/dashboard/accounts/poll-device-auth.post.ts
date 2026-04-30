import { pollDeviceAuth, pollDeviceAuthInputSchema } from "../../../services/accounts";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => pollDeviceAuth(await requireUserId(event), await readDashboardBody(event, pollDeviceAuthInputSchema)));
