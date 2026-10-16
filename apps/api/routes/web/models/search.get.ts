import { defineHandler } from "nitro";
import { searchModels } from "#web/services/models.js";
import { requireReadableUserId } from "#web/utils/api.js";

export default defineHandler(async (event) => searchModels(await requireReadableUserId(event)));
