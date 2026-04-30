import { listApiKeys } from "../../../services/api-keys";
import { requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => listApiKeys(await requireUserId(event)));
