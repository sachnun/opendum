import { defineHandler } from "nitro";
import { deleteCustomProvider, deleteCustomProviderSchema } from "#web/services/custom-providers.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => deleteCustomProvider(await requireWritableUserId(event), (await parseBody(event, deleteCustomProviderSchema)).slug));
