import { togglePinnedProvider, togglePinnedProviderInputSchema } from "../../../services/accounts";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => togglePinnedProvider(await requireWritableUserId(event), await parseBody(event, togglePinnedProviderInputSchema)));
