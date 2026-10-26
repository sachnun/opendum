import { defineHandler } from "nitro";
import { proxyContext } from "@opendum/api/context";
import { handleModels } from "@opendum/api/handlers/models";

export default defineHandler(async (event) => handleModels(event, await proxyContext()));
