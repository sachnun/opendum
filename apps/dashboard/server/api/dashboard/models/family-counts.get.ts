import { getModelFamilyCounts } from "../../../services/models";
import { requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getModelFamilyCounts(await requireUserId(event)));
