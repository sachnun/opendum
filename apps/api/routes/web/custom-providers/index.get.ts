import { defineHandler } from "nitro";
import { listCustomProviders } from "#web/services/custom-providers.js";
import { requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => listCustomProviders(await requireReadableUserId(event)));
