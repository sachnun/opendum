import { defineHandler } from "nitro";
import { createCustomProvider, createCustomProviderSchema } from "#web/services/custom-providers.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => createCustomProvider(await requireWritableUserId(event), await parseBody(event, createCustomProviderSchema)));
