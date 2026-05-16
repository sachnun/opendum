import { setAccountModelEnabled, setAccountModelEnabledInputSchema } from "../../../services/accounts";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => setAccountModelEnabled(await requireWritableUserId(event), await readDashboardBody(event, setAccountModelEnabledInputSchema)));
