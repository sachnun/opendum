import { getAccountPing } from "../../../services/accounts";
import { requireReadContext } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const context = await requireReadContext(event);
  return getAccountPing(context.userId, { autoPin: !context.isAuditMode });
});
