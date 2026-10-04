import { deleteCustomProvider, deleteCustomProviderSchema } from "~~/server/services/custom-providers";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => deleteCustomProvider(await requireWritableUserId(event), (await parseBody(event, deleteCustomProviderSchema)).slug));
