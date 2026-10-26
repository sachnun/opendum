import { defineHandler } from "nitro";
import { proxyContext } from "../../context.js";
import { handleModels } from "../../handlers/models.js";

export default defineHandler(async (event) => handleModels(event, await proxyContext()));
