import { listCustomProviders } from "../../../services/custom-providers";
import { requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => listCustomProviders(await requireReadableUserId(event)));
