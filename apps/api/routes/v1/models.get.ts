import { defineHandler } from "nitro";
import { getProxyContext } from "../../context.js";
import { handleModels } from "../../handlers/models.js";

export default defineHandler(async (event) => handleModels(event, await getProxyContext()));
