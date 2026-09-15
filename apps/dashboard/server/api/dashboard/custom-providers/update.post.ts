import { updateCustomProvider, updateCustomProviderSchema } from "../../../services/custom-providers";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => updateCustomProvider(await requireWritableUserId(event), await parseBody(event, updateCustomProviderSchema)));
