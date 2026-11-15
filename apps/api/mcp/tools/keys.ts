import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DATA_OUTPUT, DESTRUCTIVE, READ_ONLY, WRITE, call, jsonResult, needsUser, type ToolEnv } from "@opendum/api/mcp/tools/shared";

const ACCESS_MODE = z.enum(["all", "whitelist", "blacklist"]);
const RATE_RULE = z.object({
  target: z.string().trim().min(1).describe("Model id or family name"),
  targetType: z.enum(["model", "family"]),
  perMinute: z.number().int().nullable(),
  perHour: z.number().int().nullable(),
  perDay: z.number().int().nullable(),
});

export function registerKeyTools(server: McpServer, env: ToolEnv): void {
  server.registerTool(
    "apiKeys_list",
    {
      title: "List API keys",
      description:
        "List the connected user's API keys with name, prefix, status, expiry, and access settings. Full secrets are never returned here.\n\nUse when: inspect API key status before rotating or editing one.\nRisk: read.",
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async () => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("list API keys", env.context.web.apiKeys.listApiKeys(guard.userId, { expireActiveKeys: false }));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "apiKeys_options_read",
    {
      title: "API key options",
      description:
        "Read the selectable models, accounts, and limits used when creating or editing API keys.\n\nUse when: build a key's model or account access list.\nRisk: read.",
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async () => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("read API key options", env.context.web.apiKeys.getOptions(guard.userId));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "apiKeys_create",
    {
      title: "Create API key",
      description:
        "Create a new API key for the connected user. The full secret is returned exactly once.\n\nUse when: mint a key for a new client, agent, or experiment.\nNote: Store the secret immediately; it cannot be recovered later. Reveal it again with apiKeys_reveal while the key lives.\nRisk: write.",
      inputSchema: z.object({
        name: z.string().max(120).optional(),
        expiresAt: z.string().datetime().optional().describe("ISO date-time; omit to never expire"),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("create API key", env.context.web.apiKeys.createApiKey(guard.userId, {
        name: args.name,
        expiresAt: args.expiresAt ? new Date(args.expiresAt) : null,
      }));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "apiKeys_reveal",
    {
      title: "Reveal API key",
      description:
        "Reveal the full secret of one of the user's API keys.\n\nUse when: client config needs the key material again.\nNote: Only the key owner can reveal; never log the result.\nRisk: read.",
      inputSchema: z.object({ id: z.string().min(1) }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("reveal API key", env.context.web.apiKeys.revealApiKey(guard.userId, args.id));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "apiKeys_toggle",
    {
      title: "Toggle API key",
      description:
        "Toggle one API key between active and disabled without deleting it. Disabled keys fail authentication.\n\nUse when: pause a key temporarily instead of deleting it.\nRisk: write.",
      inputSchema: z.object({ id: z.string().min(1) }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("toggle API key", env.context.web.apiKeys.toggleApiKey(guard.userId, args.id));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "apiKeys_delete",
    {
      title: "Delete API key",
      description:
        "Delete one API key permanently. The key stops working immediately.\n\nUse when: rotate or revoke a compromised key.\nRisk: destructive.",
      inputSchema: z.object({ id: z.string().min(1) }),
      outputSchema: DATA_OUTPUT,
      annotations: DESTRUCTIVE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("delete API key", env.context.web.apiKeys.deleteApiKey(guard.userId, args.id));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "apiKeys_rename_update",
    {
      title: "Rename API key",
      description:
        "Rename an API key for easier identification.\n\nUse when: label keys per environment or client.\nRisk: write.",
      inputSchema: z.object({ id: z.string().min(1), name: z.string().max(120) }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("rename API key", env.context.web.apiKeys.updateName(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "apiKeys_expiration_update",
    {
      title: "Set API key expiry",
      description:
        "Set or clear the expiry of an API key. Expired keys fail authentication.\n\nUse when: time-box a key for a campaign or agent run.\nRisk: write.",
      inputSchema: z.object({
        id: z.string().min(1),
        expiresAt: z.string().datetime().nullable().describe("ISO date-time, or null to never expire"),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("update API key expiry", env.context.web.apiKeys.updateExpiration(guard.userId, {
        id: args.id,
        expiresAt: args.expiresAt ? new Date(args.expiresAt) : null,
      }));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "apiKeys_roaming_update",
    {
      title: "Set API key roaming",
      description:
        "Toggle roaming points for an API key. Roaming keys can spend the owner's points on models served by shared accounts.\n\nUse when: let a key draw from the shared point balance.\nRisk: write.",
      inputSchema: z.object({ id: z.string().min(1), enabled: z.boolean() }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("update API key roaming", env.context.web.apiKeys.updateRoaming(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "apiKeys_models_update",
    {
      title: "Set key model access",
      description:
        "Set the model access mode (all, whitelist, blacklist) and model list for an API key. The same policy filters models_list for that key.\n\nUse when: scope a key to specific models.\nRisk: write.",
      inputSchema: z.object({
        id: z.string().min(1),
        mode: ACCESS_MODE,
        models: z.array(z.string().trim().min(1)).max(500),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("update key model access", env.context.web.apiKeys.updateModels(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "apiKeys_accounts_update",
    {
      title: "Set key account access",
      description:
        "Set the account access mode (all, whitelist, blacklist) and account list for an API key. Controls which provider accounts serve this key's requests.\n\nUse when: pin a key to specific provider accounts.\nRisk: write.",
      inputSchema: z.object({
        id: z.string().min(1),
        mode: ACCESS_MODE,
        accounts: z.array(z.string().trim().min(1)).max(500),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("update key account access", env.context.web.apiKeys.updateAccess(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "apiKeys_limits_update",
    {
      title: "Set key rate limits",
      description:
        "Set per-model or per-family rate limits (per minute, hour, day) for an API key. A null limit disables that window.\n\nUse when: throttle expensive models per key.\nRisk: write.",
      inputSchema: z.object({
        id: z.string().min(1),
        rules: z.array(RATE_RULE).max(500),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("update key rate limits", env.context.web.apiKeys.updateRateLimits(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );
}
