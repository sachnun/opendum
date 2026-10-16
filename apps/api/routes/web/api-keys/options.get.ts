import { defineHandler } from "nitro";
import { getApiKeyOptions } from "#web/services/api-keys.js";
import { requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => getApiKeyOptions(await requireReadableUserId(event)));
