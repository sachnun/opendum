import { createCustomProvider, createCustomProviderSchema } from "../../../services/custom-providers";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => createCustomProvider(await requireWritableUserId(event), await parseBody(event, createCustomProviderSchema)));
