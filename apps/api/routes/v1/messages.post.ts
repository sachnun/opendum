import { defineHandler } from "nitro";
import { proxyContext } from "@opendum/api/context";
import { handleInference } from "@opendum/api/handlers/inference";
import { Messages } from "@opendum/api/core/endpoints";

export default defineHandler(async (event) =>
  handleInference(event, await proxyContext(), new Messages())
);
