import { togglePinnedProvider, togglePinnedProviderInputSchema } from "~~/server/services/accounts";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => togglePinnedProvider(await requireWritableUserId(event), await parseBody(event, togglePinnedProviderInputSchema)));
