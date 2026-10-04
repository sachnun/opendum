import { createCustomProvider, createCustomProviderSchema } from "~~/server/services/custom-providers";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => createCustomProvider(await requireWritableUserId(event), await parseBody(event, createCustomProviderSchema)));
