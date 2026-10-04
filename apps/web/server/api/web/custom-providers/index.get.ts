import { listCustomProviders } from "~~/server/services/custom-providers";
import { requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => listCustomProviders(await requireReadableUserId(event)));
