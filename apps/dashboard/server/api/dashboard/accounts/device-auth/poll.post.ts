import { pollDeviceAuth, pollDeviceAuthInputSchema } from "~~/server/services/account-auth";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => pollDeviceAuth(await requireWritableUserId(event), await parseBody(event, pollDeviceAuthInputSchema)));
