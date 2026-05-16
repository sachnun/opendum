import { togglePinnedProvider, togglePinnedProviderInputSchema } from "../../../services/accounts";
import { readDashboardBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => togglePinnedProvider(await requireWritableUserId(event), await readDashboardBody(event, togglePinnedProviderInputSchema)));
