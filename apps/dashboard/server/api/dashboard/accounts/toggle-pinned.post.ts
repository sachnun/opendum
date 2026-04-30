import { togglePinnedProvider, togglePinnedProviderInputSchema } from "../../../services/accounts";
import { readDashboardBody, requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => togglePinnedProvider(await requireUserId(event), await readDashboardBody(event, togglePinnedProviderInputSchema)));
