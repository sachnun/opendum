import { defineHandler } from "nitro";
import { listApiKeys } from "#web/services/api-keys.js";
import { requireReadContext } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  const context = await requireReadContext(event);
  return listApiKeys(context.userId, { expireActiveKeys: !context.isAuditMode });
});
