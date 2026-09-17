import { listKnownModels } from "../../../services/models";
import { requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => {
  await requireReadableUserId(event);
  return listKnownModels();
});
