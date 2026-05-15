import { getAccountPing } from "../../../services/accounts";
import { requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAccountPing(await requireUserId(event)));
