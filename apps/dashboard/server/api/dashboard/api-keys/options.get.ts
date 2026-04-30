import { getApiKeyOptions } from "../../../services/api-keys";
import { requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getApiKeyOptions(await requireUserId(event)));
