import { setModelEnabled, setModelEnabledInputSchema } from "../../../services/models";
import { parseBody, requireWritableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => setModelEnabled(await requireWritableUserId(event), await parseBody(event, setModelEnabledInputSchema)));
