import { listAccounts } from "../../../services/accounts";
import { requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => listAccounts(await requireUserId(event)));
