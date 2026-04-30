import { getPlaygroundOptions } from "../../../services/playground";
import { requireUserId } from "../../../utils/api";

export default defineEventHandler(async (event) => getPlaygroundOptions(await requireUserId(event)));
