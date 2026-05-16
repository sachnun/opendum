import { listModels } from "../../../services/models";
import { requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => listModels(await requireReadableUserId(event)));
