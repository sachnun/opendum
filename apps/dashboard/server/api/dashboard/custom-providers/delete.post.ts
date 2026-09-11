import { deleteCustomProvider, deleteCustomProviderSchema } from "../../../services/custom-providers";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => deleteCustomProvider(await requireWritableUserId(event), (await readDashboardBody(event, deleteCustomProviderSchema)).slug));
