import { getModelFamilyCounts } from "../../../services/models";
import { requireReadableUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getModelFamilyCounts(await requireReadableUserId(event)));
