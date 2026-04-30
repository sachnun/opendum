import { setModelEnabled, setModelEnabledInputSchema } from "../../../services/models";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => setModelEnabled(await requireUserId(event), await readDashboardBody(event, setModelEnabledInputSchema)));
