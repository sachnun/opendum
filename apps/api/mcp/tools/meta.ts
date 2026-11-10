import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DATA_OUTPUT, READ_ONLY, jsonResult, type ToolEnv } from "@opendum/api/mcp/tools/shared";

type FindEntry = { name: string; summary: string; keywords: string };

const FIND_INDEX: FindEntry[] = [
  { name: "gateway_health_read", summary: "Check gateway health", keywords: "health ping alive reachable gateway status" },
  { name: "models_list", summary: "List models the key can call", keywords: "models catalog available list discover" },
  { name: "models_read", summary: "Read one model's providers, limits, cost", keywords: "model details info providers cost context" },
  { name: "models_catalog_read", summary: "Read the full model catalog ids", keywords: "catalog all models ids" },
  { name: "models_search", summary: "Search user-available models with enabled state", keywords: "search models enabled providers" },
  { name: "models_families_list", summary: "List model families with counts", keywords: "families groups counts" },
  { name: "models_stats_read", summary: "Usage stats for a batch of models", keywords: "stats usage requests tokens success latency rank" },
  { name: "models_detailed_list", summary: "Dashboard model catalog with enabled state", keywords: "detailed catalog audit enabled available stats" },
  { name: "models_enabled_update", summary: "Enable or disable a model for the user", keywords: "enable disable model restrict" },
  { name: "chat_create", summary: "Create a chat completion (spends points)", keywords: "chat completion ask prompt generate reply" },
  { name: "models_cost_estimate", summary: "Estimate point cost of a model call", keywords: "cost price pricing estimate budget tokens" },
  { name: "billing_balance_read", summary: "Read remaining points balance", keywords: "balance points credits billing quota money" },
  { name: "billing_summary_read", summary: "Points balance plus daily claim status", keywords: "billing summary daily points claim" },
  { name: "apiKeys_list", summary: "List the user's API keys", keywords: "api keys list credentials tokens" },
  { name: "apiKeys_options_read", summary: "Options for creating or editing keys", keywords: "api keys options models accounts selectable" },
  { name: "apiKeys_create", summary: "Create a new API key", keywords: "api key create new generate token" },
  { name: "apiKeys_reveal", summary: "Reveal a key's secret", keywords: "api key secret reveal show copy" },
  { name: "apiKeys_toggle", summary: "Enable or disable an API key", keywords: "api key enable disable toggle pause" },
  { name: "apiKeys_delete", summary: "Delete an API key", keywords: "api key delete revoke remove" },
  { name: "apiKeys_rename_update", summary: "Rename an API key", keywords: "api key rename name" },
  { name: "apiKeys_expiration_update", summary: "Set or clear an API key expiry", keywords: "api key expires expiration ttl deadline" },
  { name: "apiKeys_roaming_update", summary: "Toggle roaming points for an API key", keywords: "api key roaming shared points" },
  { name: "apiKeys_models_update", summary: "Set model access mode and list for a key", keywords: "api key model access whitelist blacklist" },
  { name: "apiKeys_accounts_update", summary: "Set account access mode and list for a key", keywords: "api key account access whitelist blacklist" },
  { name: "apiKeys_limits_update", summary: "Set per-model or per-family rate limits for a key", keywords: "api key rate limits throttle per minute hour day" },
  { name: "accounts_list", summary: "List provider accounts", keywords: "accounts providers list connections" },
  { name: "accounts_overview_read", summary: "Overview of all provider accounts", keywords: "accounts overview health status summary" },
  { name: "accounts_ping_read", summary: "Ping all provider accounts", keywords: "accounts ping health check alive" },
  { name: "accounts_by_provider_list", summary: "List accounts of one provider", keywords: "accounts provider filter list" },
  { name: "accounts_detail_read", summary: "Detailed accounts for one provider", keywords: "accounts detail provider models health" },
  { name: "accounts_stats_read", summary: "Usage stats for a batch of accounts", keywords: "accounts stats usage requests" },
  { name: "accounts_create", summary: "Connect a provider account with a token", keywords: "accounts create connect token add provider" },
  { name: "accounts_update", summary: "Rename or activate/deactivate an account", keywords: "accounts update rename active disabled" },
  { name: "accounts_delete", summary: "Delete a provider account", keywords: "accounts delete remove disconnect" },
  { name: "accounts_pin_toggle", summary: "Pin or unpin a provider", keywords: "accounts pin prefer provider routing" },
  { name: "accounts_model_enable_update", summary: "Enable or disable a model on one account", keywords: "accounts model enable disable per account" },
  { name: "accounts_error_history_read", summary: "Error history of one account", keywords: "accounts errors history failures" },
  { name: "accounts_error_histories_read", summary: "Error history for a batch of accounts", keywords: "accounts errors batch history" },
  { name: "accounts_errors_resolve", summary: "Clear an account's error state", keywords: "accounts resolve errors reset recover" },
  { name: "accounts_auth_url_read", summary: "Start OAuth connect for a provider", keywords: "oauth connect login authorize provider browser" },
  { name: "accounts_auth_exchange", summary: "Exchange an OAuth callback code for an account", keywords: "oauth callback exchange code connect" },
  { name: "accounts_device_initiate", summary: "Start device-code auth for a provider", keywords: "device code login authorize provider" },
  { name: "accounts_device_poll", summary: "Poll a device-code auth flow", keywords: "device poll status login" },
  { name: "accounts_codex_connect", summary: "Connect a Codex session JSON", keywords: "codex session connect import" },
  { name: "accounts_quota_read", summary: "Read one account's quota", keywords: "quota limits remaining usage account" },
  { name: "accounts_quotas_list", summary: "Read quotas for a batch of accounts", keywords: "quota batch limits accounts" },
  { name: "providers_list", summary: "List custom OpenAI-compatible providers", keywords: "custom providers endpoints base url list" },
  { name: "providers_create", summary: "Create a custom provider", keywords: "custom provider create base url" },
  { name: "providers_update", summary: "Update a custom provider", keywords: "custom provider update rename base url" },
  { name: "providers_delete", summary: "Delete a custom provider", keywords: "custom provider delete remove" },
  { name: "providers_connect", summary: "Connect an account to a custom provider", keywords: "custom provider connect account token" },
  { name: "providers_models_sync", summary: "Sync model list from a custom provider", keywords: "custom provider sync models fetch" },
  { name: "providers_models_preview", summary: "Preview models from a base URL and token", keywords: "custom provider preview models test" },
  { name: "providers_models_upsert", summary: "Upsert model configs for a custom provider", keywords: "custom provider models upsert configure" },
  { name: "providers_model_delete", summary: "Delete one custom provider model", keywords: "custom provider model delete remove" },
  { name: "analytics_overview_read", summary: "Usage overview for the last 24h", keywords: "analytics usage overview requests tokens" },
  { name: "analytics_data_read", summary: "Analytics aggregates with totals and series", keywords: "analytics data totals trends" },
  { name: "analytics_series_read", summary: "Time series of requests, tokens, duration", keywords: "analytics series timeseries trends" },
  { name: "analytics_usage_list", summary: "Raw usage log rows", keywords: "usage log rows requests history" },
  { name: "session_read", summary: "Session info: user, points, sharing", keywords: "session whoami profile context" },
  { name: "sharing_read", summary: "Read account sharing setting", keywords: "sharing share status" },
  { name: "sharing_update", summary: "Toggle account sharing", keywords: "sharing share enable disable" },
  { name: "find_operations", summary: "Find tools by plain-language task", keywords: "find operations search discover tools help" },
  { name: "context_read", summary: "Server context and tool inventory", keywords: "context server inventory orientation whoami version" },
];

function findEntries(query: string): Array<{ name: string; summary: string; score: number }> {
  const tokens = query.split(/\s+/).filter(Boolean);
  const scored: Array<{ name: string; summary: string; score: number }> = [];
  for (const entry of FIND_INDEX) {
    const haystack = `${entry.name} ${entry.summary} ${entry.keywords}`.toLowerCase();
    const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
    if (score > 0) scored.push({ name: entry.name, summary: entry.summary, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function registerMetaTools(server: McpServer, env: ToolEnv): void {
  server.registerTool(
    "find_operations",
    {
      title: "Find tools",
      description:
        "Find the opendum MCP tools relevant to a task described in plain language, ranked by keyword relevance.\n\nUse when: unsure which tool to call for a goal like 'check my balance' or 'pause my key'.\nRisk: read.",
      inputSchema: z.object({
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(50).optional().default(10),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => jsonResult({ tools: findEntries(args.query.toLowerCase()).slice(0, args.limit ?? 10) })
  );

  server.registerTool(
    "context_read",
    {
      title: "Server context",
      description:
        "Read MCP server context: server identity, tool inventory, and the authenticated user scope.\n\nUse when: orient before exploring; confirm which tools exist.\nRisk: read.",
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async () =>
      jsonResult({
        server: "opendum-mcp",
        version: "0.2.0",
        userId: env.identity.userId || null,
        toolCount: FIND_INDEX.length,
        tools: FIND_INDEX.map((entry) => entry.name),
      })
  );
}
