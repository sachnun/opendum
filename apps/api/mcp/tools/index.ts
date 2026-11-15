import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { identityFromAuthInfo } from "@opendum/api/mcp/auth";
import type { McpContext } from "@opendum/api/mcp/types";
import { registerAccountTools } from "@opendum/api/mcp/tools/accounts";
import { registerAnalyticsTools } from "@opendum/api/mcp/tools/analytics";
import { registerBillingTools } from "@opendum/api/mcp/tools/billing";
import { registerGatewayTools } from "@opendum/api/mcp/tools/gateway";
import { registerKeyTools } from "@opendum/api/mcp/tools/keys";
import { registerMetaTools } from "@opendum/api/mcp/tools/meta";
import { registerModelTools } from "@opendum/api/mcp/tools/models";
import { registerProviderTools } from "@opendum/api/mcp/tools/providers";
import { registerSessionTools } from "@opendum/api/mcp/tools/session";
import type { ToolEnv } from "@opendum/api/mcp/tools/shared";

export function registerTools(server: McpServer, context: McpContext, authInfo: AuthInfo | undefined): void {
  const env: ToolEnv = {
    context,
    identity: identityFromAuthInfo(authInfo),
    authHeader: authInfo ? `Bearer ${authInfo.token}` : "",
  };
  registerGatewayTools(server, env);
  registerModelTools(server, env);
  registerKeyTools(server, env);
  registerAccountTools(server, env);
  registerProviderTools(server, env);
  registerAnalyticsTools(server, env);
  registerBillingTools(server, env);
  registerSessionTools(server, env);
  registerMetaTools(server, env);
}
