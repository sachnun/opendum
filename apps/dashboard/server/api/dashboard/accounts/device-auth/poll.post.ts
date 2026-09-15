import { pollDeviceAuth, pollDeviceAuthInputSchema } from "../../../../services/account-auth";
import { parseBody, requireWritableUserId } from "../../../../utils/api";

export default defineEventHandler(async (event) => pollDeviceAuth(await requireWritableUserId(event), await parseBody(event, pollDeviceAuthInputSchema)));
