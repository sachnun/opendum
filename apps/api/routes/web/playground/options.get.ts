import { defineHandler } from "nitro";
import { getPlaygroundOptions } from "#web/services/playground.js";
import { requestOrigin } from "#web/lib/request-origin.js";
import { requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  return getPlaygroundOptions(await requireReadableUserId(event), requestOrigin(event));
});
