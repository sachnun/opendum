import { defineHandler } from "nitro";
import { getProxyContext } from "../../context.js";
import { handleInference } from "../../handlers/inference.js";
import { Responses } from "../../core/endpoints.js";

export default defineHandler(async (event) =>
  handleInference(event, await getProxyContext(), new Responses())
);
