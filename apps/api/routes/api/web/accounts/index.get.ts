import { defineHandler } from "nitro";
import { listAccounts } from "#web/services/accounts.js";
import { requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => listAccounts(await requireReadableUserId(event)));
