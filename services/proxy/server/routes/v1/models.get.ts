import { defineHandler } from "nitro";
import { getProxyContext } from "../../context.js";
import { handleModels } from "../../../src/routes/models.js";

export default defineHandler(async (event) => handleModels(event, await getProxyContext()));
