import { createCustomProvider, createCustomProviderSchema } from "../../../services/custom-providers";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => createCustomProvider(await requireWritableUserId(event), await readDashboardBody(event, createCustomProviderSchema)));
