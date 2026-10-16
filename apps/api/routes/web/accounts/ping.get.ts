import { defineHandler } from "nitro";
import { getAccountPing } from "#web/services/accounts.js";
import { requireReadContext } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  const context = await requireReadContext(event);
  return getAccountPing(context.userId, { autoPin: !context.isAuditMode });
});
