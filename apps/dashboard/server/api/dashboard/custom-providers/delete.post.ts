import { deleteCustomProvider, deleteCustomProviderSchema } from "../../../services/custom-providers";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => deleteCustomProvider(await requireWritableUserId(event), (await parseBody(event, deleteCustomProviderSchema)).slug));
