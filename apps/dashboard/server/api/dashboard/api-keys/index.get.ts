import { listApiKeys } from "../../../services/api-keys";
import { requireReadContext } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  const context = await requireReadContext(event);
  return listApiKeys(context.userId, { expireActiveKeys: !context.isAuditMode });
});
