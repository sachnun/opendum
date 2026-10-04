import { getApiKeyOptions } from "~~/server/services/api-keys";
import { requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => getApiKeyOptions(await requireReadableUserId(event)));
