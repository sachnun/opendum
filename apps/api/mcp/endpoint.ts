import { createMcpHandler, requireBearerAuth, type McpHttpHandler } from "@modelcontextprotocol/server";
import type { H3Event } from "h3";
import { requestOrigin, verifyOpendumKey } from "@opendum/api/mcp/auth";
import { createMcpServer } from "@opendum/api/mcp/server";
import type { McpContext } from "@opendum/api/mcp/types";

type CachedHandler = { context: McpContext; handler: McpHttpHandler };

const cachedState: { current?: CachedHandler } = {};

function handlerFor(context: McpContext): McpHttpHandler {
  const cached = cachedState.current;
  if (cached && cached.context === context) return cached.handler;
  const handler = createMcpHandler((ctx) => createMcpServer(context, ctx.authInfo));
  cachedState.current = { context, handler };
  return handler;
}

export function mcpEndpoint(
  context: McpContext,
  handler: McpHttpHandler = handlerFor(context)
): (event: H3Event) => Promise<Response> {
  return async (event) => {
    const request = event.req;
    const gate = requireBearerAuth({
      verifier: { verifyAccessToken: (token) => verifyOpendumKey(context, token) },
      resourceMetadataUrl: `${requestOrigin(request)}/.well-known/oauth-protected-resource/mcp`,
    });
    const auth = await gate(request);
    if (auth instanceof Response) return auth;
    return handler.fetch(request, { authInfo: auth });
  };
}
