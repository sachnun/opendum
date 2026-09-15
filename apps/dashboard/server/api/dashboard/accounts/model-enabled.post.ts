import { setAccountModelEnabled, setAccountModelEnabledInputSchema } from "../../../services/accounts";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => setAccountModelEnabled(await requireWritableUserId(event), await parseBody(event, setAccountModelEnabledInputSchema)));
