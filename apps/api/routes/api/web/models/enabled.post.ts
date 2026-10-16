import { defineHandler } from "nitro";
import { setModelEnabled, setModelEnabledInputSchema } from "#web/services/models.js";
import { parseBody, requireWritableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => setModelEnabled(await requireWritableUserId(event), await parseBody(event, setModelEnabledInputSchema)));
