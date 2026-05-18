import { getUserPointStatus } from "../../services/points";
import { requireReadableUserId } from "../../utils/api";

export default defineEventHandler(async (event) => getUserPointStatus(await requireReadableUserId(event)));
