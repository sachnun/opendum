import { searchModels } from "~~/server/services/models";
import { requireReadableUserId } from "~~/server/utils/api";

export default defineEventHandler(async (event) => searchModels(await requireReadableUserId(event)));
