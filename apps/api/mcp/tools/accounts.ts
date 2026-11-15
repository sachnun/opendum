import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DATA_OUTPUT, DESTRUCTIVE, READ_ONLY, WRITE, call, jsonResult, needsUser, type ToolEnv } from "@opendum/api/mcp/tools/shared";

const PROVIDER = z.string().trim().min(1).describe("Provider key, e.g. codex, cline, antigravity");
const ACCOUNT_ID = z.string().trim().min(1);

export function registerAccountTools(server: McpServer, env: ToolEnv): void {
  server.registerTool(
    "accounts_list",
    {
      title: "List accounts",
      description:
        "List the connected user's provider accounts with provider, name, and status.\n\nUse when: see which provider connections back the gateway.\nRisk: read.",
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async () => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("list accounts", env.context.web.accounts.listAccounts(guard.userId));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_overview_read",
    {
      title: "Accounts overview",
      description:
        "Read an overview of all provider accounts: health, indicators, and per-provider summaries.\n\nUse when: get a single health snapshot across every provider.\nRisk: read.",
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async () => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("read accounts overview", env.context.web.accounts.getAccountOverview(guard.userId, { autoPin: false }));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_ping_read",
    {
      title: "Ping accounts",
      description:
        "Ping all provider accounts to check which are reachable right now.\n\nUse when: verify provider connectivity before debugging request failures.\nRisk: read.",
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async () => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("ping accounts", env.context.web.accounts.getAccountPing(guard.userId, { autoPin: false }));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_by_provider_list",
    {
      title: "Accounts by provider",
      description:
        "List the accounts belonging to one provider.\n\nUse when: inspect a single provider's connections.\nRisk: read.",
      inputSchema: z.object({ provider: PROVIDER }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("list accounts by provider", env.context.web.accounts.listByProvider(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_detail_read",
    {
      title: "Account details",
      description:
        "Read detailed accounts for one provider, including model health per account.\n\nUse when: drill into why a provider serves fewer models than expected.\nRisk: read.",
      inputSchema: z.object({ provider: PROVIDER }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("read account details", env.context.web.accounts.accountsDetailed(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_stats_read",
    {
      title: "Account stats",
      description:
        "Read usage stats for a batch of provider accounts.\n\nUse when: find which account carries most traffic.\nRisk: read.",
      inputSchema: z.object({ accountIds: z.array(ACCOUNT_ID).max(50) }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("read account stats", env.context.web.accounts.getAccountStats(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_create",
    {
      title: "Connect account",
      description:
        "Connect a provider account with an API token for the connected user.\n\nUse when: add a new provider credential to the gateway.\nNote: Handle the token as a secret; it is stored encrypted.\nRisk: write.",
      inputSchema: z.object({
        provider: z.string().min(1),
        name: z.string().optional(),
        token: z.string().min(1),
        cfAccountId: z.string().optional(),
        platformKey: z.string().optional(),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("create account", env.context.web.accounts.createAccount(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_update",
    {
      title: "Update account",
      description:
        "Rename an account, or activate/deactivate it, or set a cooldown. Pass disabledUntil as ISO date-time or null to clear it.\n\nUse when: quarantine a misbehaving account without deleting it.\nRisk: write.",
      inputSchema: z.object({
        id: ACCOUNT_ID,
        name: z.string().max(120).optional(),
        isActive: z.boolean().optional(),
        disabledUntil: z.string().datetime().nullable().optional(),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("update account", env.context.web.accounts.updateAccount(guard.userId, {
        id: args.id,
        name: args.name,
        isActive: args.isActive,
        disabledUntil: args.disabledUntil === undefined ? undefined : args.disabledUntil ? new Date(args.disabledUntil) : null,
      }));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_delete",
    {
      title: "Delete account",
      description:
        "Delete a provider account and its stored credential permanently.\n\nUse when: disconnect a provider entirely.\nRisk: destructive.",
      inputSchema: z.object({ id: ACCOUNT_ID }),
      outputSchema: DATA_OUTPUT,
      annotations: DESTRUCTIVE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("delete account", env.context.web.accounts.deleteAccount(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_pin_toggle",
    {
      title: "Pin or unpin provider",
      description:
        "Pin or unpin a provider so routing prefers it. Calling again unpins.\n\nUse when: steer traffic toward a preferred provider.\nRisk: write.",
      inputSchema: z.object({ providerKey: z.string().trim().min(1) }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("toggle pinned provider", env.context.web.accounts.togglePinnedProvider(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_model_enable_update",
    {
      title: "Enable model on account",
      description:
        "Enable or disable one model on one specific provider account.\n\nUse when: stop a single account from serving a model while others keep serving it.\nRisk: write.",
      inputSchema: z.object({ accountId: ACCOUNT_ID, modelId: z.string().trim().min(1), enabled: z.boolean() }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("update account model", env.context.web.accounts.enableModel(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_error_history_read",
    {
      title: "Account error history",
      description:
        "Read recent error history entries for one account.\n\nUse when: diagnose why an account is failing.\nRisk: read.",
      inputSchema: z.object({ accountId: ACCOUNT_ID, limit: z.number().int().min(1).max(200).optional() }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("read error history", env.context.web.accounts.errorHistory(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_error_histories_read",
    {
      title: "Batch error history",
      description:
        "Read error history for a batch of accounts at once, keyed by account id.\n\nUse when: compare failures across several accounts.\nRisk: read.",
      inputSchema: z.object({ accountIds: z.array(ACCOUNT_ID).max(50), limit: z.number().int().min(1).max(200).optional() }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("read error histories", env.context.web.accounts.errorHistories(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_errors_resolve",
    {
      title: "Resolve account errors",
      description:
        "Clear an account's error counters and history, and re-activate it if it was marked failed.\n\nUse when: an account recovered and should serve traffic again.\nRisk: write.",
      inputSchema: z.object({ accountId: ACCOUNT_ID }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("resolve account errors", env.context.web.accounts.resolveAccountErrors(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_auth_url_read",
    {
      title: "OAuth authorize URL",
      description:
        "Build the browser OAuth authorize URL for a provider. Open the URL, authorize, then pass the callback URL to accounts_auth_exchange.\n\nUse when: connect an OAuth provider account (browser login).\nRisk: read.",
      inputSchema: z.object({ provider: z.string().min(1).describe("OAuth provider key") }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("build auth URL", env.context.web.accountAuth.authUrlFor({ provider: args.provider }));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_auth_exchange",
    {
      title: "OAuth callback exchange",
      description:
        "Exchange an OAuth callback URL (with code and state) for a connected provider account.\n\nUse when: complete the browser OAuth flow started with accounts_auth_url_read.\nRisk: write.",
      inputSchema: z.object({
        provider: z.string().min(1),
        callbackUrl: z.string().min(1),
        state: z.string().nullable().optional(),
        codeVerifier: z.string().nullable().optional(),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("exchange OAuth code", env.context.web.accountAuth.exchangeAccount(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_device_initiate",
    {
      title: "Device auth initiate",
      description:
        "Start a device-code authorization flow for a provider. Returns a user code and verification URL for the user to approve elsewhere.\n\nUse when: connect a provider that uses device login.\nRisk: read.",
      inputSchema: z.object({ provider: z.string().min(1), method: z.string().optional() }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("initiate device auth", env.context.web.accountAuth.initiateDeviceAuth(args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_device_poll",
    {
      title: "Device auth poll",
      description:
        "Poll a device-code authorization flow. Status is pending, error, or success; on success the account is stored.\n\nUse when: check whether the user approved the device code.\nRisk: write.",
      inputSchema: z.object({
        provider: z.string().min(1),
        deviceCode: z.string().min(1),
        userCode: z.string().optional(),
        codeVerifier: z.string().optional(),
        method: z.string().optional(),
        machineId: z.string().optional(),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("poll device auth", env.context.web.accountAuth.pollAuth(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_codex_connect",
    {
      title: "Connect Codex session",
      description:
        "Connect a Codex account from an exported session JSON.\n\nUse when: import a Codex session obtained from the Codex CLI.\nNote: The session JSON contains credentials; handle it as a secret.\nRisk: write.",
      inputSchema: z.object({ sessionJson: z.string().min(1) }),
      outputSchema: DATA_OUTPUT,
      annotations: WRITE,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("connect Codex session", env.context.web.accountAuth.connectCodex(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_quota_read",
    {
      title: "Account quota",
      description:
        "Read the current quota of one provider account: limits, remaining, reset timing.\n\nUse when: check how much of a provider's quota is left.\nRisk: read.",
      inputSchema: z.object({
        provider: z.string().min(1),
        accountId: ACCOUNT_ID,
        forceRefresh: z.boolean().optional(),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("read account quota", env.context.web.accountQuota.getAccountQuota(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );

  server.registerTool(
    "accounts_quotas_list",
    {
      title: "Batch account quotas",
      description:
        "Read quotas for a batch of accounts of one quota-capable provider.\n\nUse when: compare quota across many accounts at once.\nRisk: read.",
      inputSchema: z.object({
        provider: z.string().min(1),
        accountIds: z.array(ACCOUNT_ID).min(1).max(100),
        forceRefresh: z.boolean().optional(),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => {
      const guard = needsUser(env);
      if ("error" in guard) return guard.error;
      const result = await call("read account quotas", env.context.web.accountQuota.getAccountQuotas(guard.userId, args));
      return "value" in result ? jsonResult(result.value) : result.error;
    }
  );
}
