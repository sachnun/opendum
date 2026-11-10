import { defineHandler } from "nitro";
import { proxyContext } from "@opendum/api/context";
import { mcpEndpoint } from "@opendum/api/mcp/endpoint";
import { realWebServices } from "@opendum/api/mcp/web-services";
import type { McpContext } from "@opendum/api/mcp/types";

export default defineHandler(async (event) => {
  const proxy = await proxyContext();
  const context: McpContext = {
    models: proxy.models,
    auth: proxy.auth,
    service: proxy.service,
    web: realWebServices,
  };
  return mcpEndpoint(context)(event);
});
