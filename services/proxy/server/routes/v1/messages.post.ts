import { defineHandler } from "nitro";
import { getProxyContext } from "../../context.js";
import { handleInference } from "../../../src/routes/inference.js";
import { messagesConfig } from "../../../src/core/endpoints.js";

export default defineHandler(async (event) =>
  handleInference(event, await getProxyContext(), messagesConfig())
);
