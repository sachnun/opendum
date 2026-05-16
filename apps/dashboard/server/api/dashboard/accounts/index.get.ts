import { listAccounts } from "../../../services/accounts";
import { requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => listAccounts(await requireReadableUserId(event)));
