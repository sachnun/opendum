import { updateCustomProvider, updateCustomProviderSchema } from "~~/server/services/custom-providers";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => updateCustomProvider(await requireWritableUserId(event), await parseBody(event, updateCustomProviderSchema)));
