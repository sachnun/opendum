import { defineHandler } from "nitro";
import { proxyContext } from "../../context.js";
import { handleInference } from "../../handlers/inference.js";
import { Messages } from "../../core/endpoints.js";

export default defineHandler(async (event) =>
  handleInference(event, await proxyContext(), new Messages())
);
