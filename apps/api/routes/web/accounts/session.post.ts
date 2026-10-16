import { defineHandler } from "nitro";
import { HTTPError } from "h3";
import { accountSessionInputSchema, getAccountSession } from "#web/services/accounts.js";
import { parseBody, requireContext } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  const context = await requireContext(event);
  if (process.env.NODE_ENV === "production" && !context.isMaintainer) {
    throw new HTTPError({ status: 404, statusText: "Not Found" });
  }
  if (context.isAuditMode) {
    throw new HTTPError({ status: 403, statusText: "Audit mode is read-only" });
  }

  return getAccountSession(context.userId, await parseBody(event, accountSessionInputSchema));
});
