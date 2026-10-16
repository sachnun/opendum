import { defineHandler } from "nitro";
import { updateCustomProvider, updateCustomProviderSchema } from "#web/services/custom-providers.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => updateCustomProvider(await requireWritableUserId(event), await parseBody(event, updateCustomProviderSchema)));
