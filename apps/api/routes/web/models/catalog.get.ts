import { defineHandler } from "nitro";
import { listKnownModels } from "#web/services/models.js";
import { requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  await requireReadableUserId(event);
  return listKnownModels();
});
