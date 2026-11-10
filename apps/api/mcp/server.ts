import { McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import type { McpContext } from "@opendum/api/mcp/types";
import { registerTools } from "@opendum/api/mcp/tools/index";

const SERVER_NAME = "opendum-mcp";
const SERVER_VERSION = "0.2.0";

const INSTRUCTIONS = [
  "opendum exposes an open community LLM gateway over MCP.",
  "Start with context_read, then use find_operations when unsure which tool fits a task.",
  "Discover models with models_list, inspect one with models_read, and estimate spend with models_cost_estimate.",
  "Run completions with chat_create (spends points); check billing_balance_read for remaining points.",
  "Manage API keys with apiKeys_* tools, provider accounts with accounts_* tools, custom providers with providers_* tools, and usage with analytics_* tools.",
  "Every tool is scoped to the owner of the connected opendum API key. Writes are annotated; delete tools are destructive.",
  "Chat messages follow the OpenAI chat completions format.",
].join(" ");

export function createMcpServer(context: McpContext, authInfo?: AuthInfo): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, context, authInfo);
  return server;
}
