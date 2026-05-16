import { setModelEnabled, setModelEnabledInputSchema } from "../../../services/models";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => setModelEnabled(await requireWritableUserId(event), await readDashboardBody(event, setModelEnabledInputSchema)));
