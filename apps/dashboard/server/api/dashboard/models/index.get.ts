import { listModels } from "../../../services/models";
import { requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => listModels(await requireUserId(event)));
