import { defineHandler } from "nitro";
import { getModelFamilyCounts } from "#web/services/models.js";
import { requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  await requireReadableUserId(event);
  return getModelFamilyCounts();
});
