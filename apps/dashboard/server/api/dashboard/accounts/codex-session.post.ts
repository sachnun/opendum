import { connectCodexSessionAccount, connectCodexSessionInputSchema } from "../../../services/account-auth";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => connectCodexSessionAccount(await requireWritableUserId(event), await readDashboardBody(event, connectCodexSessionInputSchema)));
