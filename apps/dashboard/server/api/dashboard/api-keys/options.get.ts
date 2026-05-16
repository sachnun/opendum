import { getApiKeyOptions } from "../../../services/api-keys";
import { requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getApiKeyOptions(await requireReadableUserId(event)));
