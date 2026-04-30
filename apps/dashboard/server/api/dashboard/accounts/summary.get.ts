import { getAccountSummary } from "../../../services/accounts";
import { requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAccountSummary(await requireUserId(event)));
