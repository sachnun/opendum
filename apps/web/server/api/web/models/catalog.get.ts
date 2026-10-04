import { listKnownModels } from "~~/server/services/models";
import { requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => {
  await requireReadableUserId(event);
  return listKnownModels();
});
