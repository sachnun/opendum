import { setAccountModelEnabled, setAccountModelEnabledInputSchema } from "../../../services/accounts";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => setAccountModelEnabled(await requireUserId(event), await readDashboardBody(event, setAccountModelEnabledInputSchema)));
