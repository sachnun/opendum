import { setModelEnabled, setModelEnabledInputSchema } from "~~/server/services/models";
import { parseBody, requireWritableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => setModelEnabled(await requireWritableUserId(event), await parseBody(event, setModelEnabledInputSchema)));
