import { defineHandler } from "nitro";
import { togglePinnedProvider, togglePinnedProviderInputSchema } from "#web/services/accounts.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => togglePinnedProvider(await requireWritableUserId(event), await parseBody(event, togglePinnedProviderInputSchema)));
