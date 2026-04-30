import { searchModels } from "../../../services/models";
import { requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => searchModels(await requireUserId(event)));
