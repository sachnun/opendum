import { searchModels } from "../../../services/models";
import { requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => searchModels(await requireReadableUserId(event)));
