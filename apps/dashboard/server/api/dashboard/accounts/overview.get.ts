import { getAccountOverview } from "../../../services/accounts";
import { requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getAccountOverview(await requireUserId(event)));
