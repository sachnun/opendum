import { listAccounts } from "~~/server/services/accounts";
import { requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => listAccounts(await requireReadableUserId(event)));
