import { updateCustomProvider, updateCustomProviderSchema } from "../../../services/custom-providers";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateCustomProvider(await requireWritableUserId(event), await readDashboardBody(event, updateCustomProviderSchema)));
