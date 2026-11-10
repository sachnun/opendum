import { afterEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type AuthInfo, type McpServer } from "@modelcontextprotocol/server";
import { MCP_SCOPE } from "@opendum/api/mcp/auth";
import { createMcpServer } from "@opendum/api/mcp/server";
import type { McpContext, McpWebServices } from "@opendum/api/mcp/types";
import { emptyAvailability, emptyResult, type AuthResult } from "@opendum/auth/types";

const MODEL_ENTRIES = [
  { id: "openai/gpt-5.5", object: "model", providers: ["openai"], reasoning: true },
  { id: "google/gemini-3.5-flash", object: "model", providers: ["google"] },
  { id: "z-ai/glm-5.2", object: "model", providers: ["zro"] },
];

const VALID_RESULT: AuthResult = {
  valid: true,
  userId: "user-1",
  apiKeyId: "key-1",
  modelAccessMode: "all",
  modelAccessList: [],
  accountAccessMode: "all",
  accountAccessList: [],
  roamingEnabled: false,
  rateLimitRules: [],
  error: "",
};

const DEFAULT_MODELS = {
  openAiModels: () => MODEL_ENTRIES,
  resolveAlias: (model: string) => model,
  modelFamily: () => "",
  modelCost: (model: string) =>
    model === "openai/gpt-5.5" ? { input: 10, output: 40, cacheRead: 1, cacheWrite: 12 } : null,
};

const DEFAULT_AUTH = {
  validateKey: () => Effect.succeed(VALID_RESULT),
  disabledModels: () => Effect.succeed(new Set<string>()),
  availability: () => Effect.succeed(emptyAvailability()),
  usable: () => true,
  usableShared: () => false,
  list: () => Effect.succeed([]),
};

const DEFAULT_WEB: McpWebServices = {
  models: {
    listModels: () => Effect.succeed([]),
    searchModels: () => Effect.succeed([]),
    knownModels: () => MODEL_ENTRIES.map((entry) => entry.id),
    getModelStats: () => Effect.succeed({}),
    familyCounts: () => Effect.succeed({ openai: 1, google: 1, "z-ai": 1 }),
    enableModel: () => Effect.succeed({ success: true as const, data: { model: "openai/gpt-5.5", enabled: true } }),
  },
  analytics: {
    getAnalyticsData: () => Effect.succeed({ totals: { totalRequests: 5 } }),
    getAnalyticsSeries: () => Effect.succeed({ requestsOverTime: [] }),
    getAnalyticsOverview: () => Effect.succeed({ requests: 5, successRate: 100 }),
    getUsageRows: () => Effect.succeed([{ id: "u-1", model: "openai/gpt-5.5" }]),
  },
  apiKeys: {
    listApiKeys: () => Effect.succeed([{ id: "key-1", name: "default" }]),
    getOptions: () => Effect.succeed({ models: [] }),
    createApiKey: () => Effect.succeed({ id: "key-2", key: "opendum-secret" }),
    toggleApiKey: () => Effect.succeed({ success: true as const, data: { id: "key-1", isActive: false } }),
    deleteApiKey: () => Effect.succeed({ success: true as const, data: { id: "key-1" } }),
    revealApiKey: () => Effect.succeed("opendum-secret"),
    updateName: () => Effect.succeed({ success: true as const, data: { id: "key-1" } }),
    updateExpiration: () => Effect.succeed({ success: true as const, data: { id: "key-1" } }),
    updateRoaming: () => Effect.succeed({ success: true as const, data: { id: "key-1" } }),
    updateModels: () => Effect.succeed({ success: true as const, data: { id: "key-1" } }),
    updateAccess: () => Effect.succeed({ success: true as const, data: { id: "key-1" } }),
    updateRateLimits: () => Effect.succeed({ success: true as const, data: { id: "key-1" } }),
  },
  accounts: {
    listAccounts: () => Effect.succeed([{ id: "acc-1", provider: "codex" }]),
    listByProvider: () => Effect.succeed([]),
    getAccountOverview: () => Effect.succeed({ total: 1 }),
    getAccountPing: () => Effect.succeed({ alive: 1 }),
    accountsDetailed: () => Effect.succeed([]),
    getAccountStats: () => Effect.succeed({}),
    updateAccount: () => Effect.succeed({ success: true as const, data: { id: "acc-1" } }),
    deleteAccount: () => Effect.succeed({ success: true as const, data: { id: "acc-1" } }),
    togglePinnedProvider: () => Effect.succeed({ success: true as const, data: { provider: "codex", pinned: true } }),
    enableModel: () => Effect.succeed({ success: true as const, data: { id: "acc-1" } }),
    errorHistory: () => Effect.succeed({ entries: [] }),
    errorHistories: () => Effect.succeed({ success: true as const, data: {} }),
    resolveAccountErrors: () => Effect.succeed({ success: true as const, data: undefined }),
    createAccount: () => Effect.succeed({ success: true as const, data: { id: "acc-2", email: "a@b.c", isUpdate: false } }),
  },
  accountQuota: {
    getAccountQuota: () => Effect.succeed({ remaining: 42 }),
    getAccountQuotas: () => Effect.succeed({ "acc-1": { remaining: 42 } }),
  },
  accountAuth: {
    authUrlFor: () => Effect.succeed({ success: true as const, data: { url: "https://example/auth" } }),
    exchangeAccount: () => Effect.succeed({ success: true as const, data: { email: "a@b.c", isUpdate: false } }),
    connectCodex: () => Effect.succeed({ success: true as const, data: { email: "a@b.c", isUpdate: false } }),
    initiateDeviceAuth: () => Effect.succeed({ success: true as const, data: { userCode: "ABC-1" } }),
    pollAuth: () => Effect.succeed({ success: true as const, data: { status: "pending", retryAfterSeconds: 5 } }),
  },
  customProviders: {
    listCustomProviders: () => Effect.succeed([{ slug: "local", name: "Local" }]),
    customProviderModels: () => Effect.succeed([]),
    createCustomProvider: () => Effect.succeed({ success: true as const, data: { slug: "local" } }),
    updateCustomProvider: () => Effect.succeed({ success: true as const, data: { slug: "local" } }),
    deleteCustomProvider: () => Effect.succeed({ success: true as const, data: { slug: "local" } }),
    connectCustom: () => Effect.succeed({ success: true as const, data: { slug: "local" } }),
    syncCustomModels: () => Effect.succeed({ success: true as const, data: { count: 3 } }),
    previewCustomModels: () => Effect.succeed([{ id: "x" }]),
    upsertCustomModels: () => Effect.succeed({ success: true as const, data: { count: 1 } }),
    deleteCustomModel: () => Effect.succeed({ success: true as const, data: { id: "x" } }),
  },
  points: {
    pointStatus: () => Effect.succeed({ balance: 42, roamingByKey: { "key-1": 3 } }),
    claimDaily: () => Effect.succeed(true),
  },
  sharing: {
    sharingEnabled: () => Effect.succeed(false),
    setSharing: () => Effect.succeed({ enabled: true }),
  },
};

const DEFAULT_BASE = {
  models: DEFAULT_MODELS,
  auth: DEFAULT_AUTH,
  service: { handle: async () => Response.json({ error: { message: "service must not be called" } }, { status: 500 }) },
  web: DEFAULT_WEB,
};

type PartialOverrides = {
  models?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  service?: Record<string, unknown>;
  web?: Partial<McpWebServices>;
};

function contextWith(overrides: PartialOverrides = {}): McpContext {
  return { ...DEFAULT_BASE, ...overrides } as unknown as McpContext;
}

type ChatCall = { payload: Record<string, unknown>; authHeader: string; sessionId: string; endpoint: string };

function serviceCapturing(response: Response): { service: Record<string, unknown>; calls: ChatCall[] } {
  const calls: ChatCall[] = [];
  const service = {
    handle: async (
      cfg: unknown,
      payload: Record<string, unknown>,
      authHeader: string,
      sessionId: string
    ): Promise<Response> => {
      calls.push({ payload, authHeader, sessionId, endpoint: String((cfg as { endpoint?: unknown }).endpoint) });
      return response;
    },
  };
  return { service, calls };
}

function authInfoWith(extra: Record<string, unknown>): AuthInfo {
  return {
    token: "opendum-key",
    clientId: "key-1",
    scopes: [MCP_SCOPE],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra,
  };
}

const ANONYMOUS: AuthInfo = {
  token: "",
  clientId: "anonymous",
  scopes: [],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const OPENED: Array<{ client: Client; server: McpServer }> = [];

async function connect(context: McpContext, authInfo?: AuthInfo): Promise<Client> {
  const server = createMcpServer(context, authInfo);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-harness", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  OPENED.push({ client, server });
  return client;
}

function structuredOf(result: unknown): Record<string, unknown> | undefined {
  const value = (result as { structuredContent?: unknown }).structuredContent;
  return value === undefined || value === null ? undefined : (value as Record<string, unknown>);
}

function dataOf(result: unknown): unknown {
  return structuredOf(result)?.data;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.map((block) => block.text ?? "").join("\n");
}

afterEach(async () => {
  while (OPENED.length > 0) {
    const pair = OPENED.pop();
    await pair?.client.close();
    await pair?.server.close();
  }
});

test("gateway_health_read answers ok", async () => {
  const client = await connect(contextWith(), ANONYMOUS);
  const result = await client.callTool({ name: "gateway_health_read", arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(structuredOf(result)).toEqual({ ok: true });
});

test("models_list returns the visible catalog for the authenticated identity", async () => {
  const client = await connect(contextWith(), authInfoWith({ userId: "user-1", modelAccessMode: "all" }));
  const result = await client.callTool({ name: "models_list", arguments: {} });
  expect(result.isError).toBeFalsy();
  const structured = structuredOf(result);
  expect(structured?.total).toBe(3);
  expect(Array.isArray(structured?.models)).toBe(true);
});

test("models_list filters by query substring and limit", async () => {
  const client = await connect(contextWith(), authInfoWith({ userId: "user-1", modelAccessMode: "all" }));
  const filtered = await client.callTool({ name: "models_list", arguments: { query: "GEMINI" } });
  expect(structuredOf(filtered)?.total).toBe(1);
  const limited = await client.callTool({ name: "models_list", arguments: { limit: 1 } });
  expect(structuredOf(limited)?.total).toBe(1);
});

test("models_list honors key whitelist mode", async () => {
  const client = await connect(
    contextWith(),
    authInfoWith({ userId: "user-1", modelAccessMode: "whitelist", modelAccessList: ["openai/gpt-5.5"] })
  );
  const result = await client.callTool({ name: "models_list", arguments: {} });
  const structured = structuredOf(result);
  expect(structured?.total).toBe(1);
  const models = (structured?.models ?? []) as Array<Record<string, unknown>>;
  expect(models[0].id).toBe("openai/gpt-5.5");
});

test("models_read resolves aliases and reports unknown ids as tool errors", async () => {
  const client = await connect(contextWith(), ANONYMOUS);
  const found = await client.callTool({ name: "models_read", arguments: { model: "google/gemini-3.5-flash" } });
  expect(found.isError).toBeFalsy();
  expect(structuredOf(found)?.requested).toBe("google/gemini-3.5-flash");
  const missing = await client.callTool({ name: "models_read", arguments: { model: "nope" } });
  expect(missing.isError).toBe(true);
  expect(textOf(missing)).toContain("Unknown model");
});

test("models_cost_estimate applies per-million-token rates", async () => {
  const client = await connect(contextWith(), ANONYMOUS);
  const result = await client.callTool({
    name: "models_cost_estimate",
    arguments: { model: "openai/gpt-5.5", inputTokens: 1_000_000, outputTokens: 500_000 },
  });
  expect(result.isError).toBeFalsy();
  const data = dataOf(result) as Record<string, unknown>;
  expect(data.rawPoints).toBe(30);
  expect(data.estimatedPoints).toBe(30);
});

test("chat_create sends a non-stream OpenAI payload and returns the assistant message", async () => {
  const response = Response.json({
    id: "chatcmpl-1",
    model: "openai/gpt-5.5",
    choices: [{ index: 0, message: { role: "assistant", content: "Hello there" }, finish_reason: "stop" }],
    usage: { total_tokens: 12 },
  });
  const { service, calls } = serviceCapturing(response);
  const client = await connect(contextWith({ service }), authInfoWith({ userId: "user-1" }));

  const result = await client.callTool({
    name: "chat_create",
    arguments: {
      model: "openai/gpt-5.5",
      messages: [{ role: "user", content: "Hi" }],
      system: "Be terse",
      temperature: 0.2,
      params: { top_p: 0.9 },
    },
  });

  expect(result.isError).toBeFalsy();
  expect(textOf(result)).toBe("Hello there");
  expect(structuredOf(result)).toEqual({
    id: "chatcmpl-1",
    model: "openai/gpt-5.5",
    usage: { total_tokens: 12 },
    message: { role: "assistant", content: "Hello there" },
  });

  expect(calls).toHaveLength(1);
  const chatCall = calls[0];
  expect(chatCall.endpoint).toBe("chat_completions");
  expect(chatCall.payload.stream).toBe(false);
  expect(chatCall.payload.model).toBe("openai/gpt-5.5");
  expect(chatCall.payload.temperature).toBe(0.2);
  expect(chatCall.payload.top_p).toBe(0.9);
  expect(chatCall.payload.messages).toEqual([
    { role: "system", content: "Be terse" },
    { role: "user", content: "Hi" },
  ]);
  expect(chatCall.sessionId).not.toBe("");
});

test("chat_create surfaces tool calls requested by the model", async () => {
  const response = Response.json({
    id: "chatcmpl-2",
    model: "openai/gpt-5.5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  const { service, calls } = serviceCapturing(response);
  const client = await connect(contextWith({ service }), authInfoWith({ userId: "user-1" }));

  const result = await client.callTool({
    name: "chat_create",
    arguments: {
      model: "openai/gpt-5.5",
      messages: [{ role: "user", content: "Find otters" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    },
  });

  expect(result.isError).toBeFalsy();
  expect(textOf(result)).toContain("Tool call requested: lookup");
  expect(calls[0].payload.tools).toEqual([{ type: "function", function: { name: "lookup", parameters: {} } }]);
});

test("chat_create maps gateway failures to tool errors with the upstream message", async () => {
  const response = Response.json(
    { error: { message: "Rate limit reached", type: "rate_limit_error", param: null, code: null } },
    { status: 429 }
  );
  const { service } = serviceCapturing(response);
  const client = await connect(contextWith({ service }), authInfoWith({ userId: "user-1" }));

  const result = await client.callTool({
    name: "chat_create",
    arguments: { model: "openai/gpt-5.5", messages: [{ role: "user", content: "Hi" }] },
  });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("429");
  expect(textOf(result)).toContain("Rate limit reached");
});

test("billing_balance_read refuses anonymous identities", async () => {
  const client = await connect(contextWith(), ANONYMOUS);
  const result = await client.callTool({ name: "billing_balance_read", arguments: {} });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("No authenticated user");
});

test("billing_balance_read returns points for the key owner", async () => {
  const client = await connect(contextWith(), authInfoWith({ userId: "user-1" }));
  const result = await client.callTool({ name: "billing_balance_read", arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(structuredOf(result)).toEqual({ balance: 42, roamingByKey: { "key-1": 3 } });
});

test("billing_summary_read claims daily points then reports balance", async () => {
  const client = await connect(contextWith(), authInfoWith({ userId: "user-1" }));
  const result = await client.callTool({ name: "billing_summary_read", arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(dataOf(result)).toEqual({ balance: 42, roamingByKey: { "key-1": 3 }, dailyClaimed: true });
});

test("models_catalog_read works without a user identity", async () => {
  const client = await connect(contextWith(), ANONYMOUS);
  const result = await client.callTool({ name: "models_catalog_read", arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(dataOf(result)).toEqual(["openai/gpt-5.5", "google/gemini-3.5-flash", "z-ai/glm-5.2"]);
});

test("apiKeys_list returns the stubbed keys", async () => {
  const client = await connect(contextWith(), authInfoWith({ userId: "user-1" }));
  const result = await client.callTool({ name: "apiKeys_list", arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(dataOf(result)).toEqual([{ id: "key-1", name: "default" }]);
});

test("apiKeys_create returns the new secret once", async () => {
  const client = await connect(contextWith(), authInfoWith({ userId: "user-1" }));
  const result = await client.callTool({ name: "apiKeys_create", arguments: { name: "agent" } });
  expect(result.isError).toBeFalsy();
  expect(dataOf(result)).toEqual({ id: "key-2", key: "opendum-secret" });
});

test("accounts_list returns provider accounts", async () => {
  const client = await connect(contextWith(), authInfoWith({ userId: "user-1" }));
  const result = await client.callTool({ name: "accounts_list", arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(dataOf(result)).toEqual([{ id: "acc-1", provider: "codex" }]);
});

test("accounts device flow tools pass through service results", async () => {
  const client = await connect(contextWith(), authInfoWith({ userId: "user-1" }));
  const initiated = await client.callTool({ name: "accounts_device_initiate", arguments: { provider: "codex" } });
  expect(initiated.isError).toBeFalsy();
  expect(dataOf(initiated)).toEqual({ success: true, data: { userCode: "ABC-1" } });
  const polled = await client.callTool({ name: "accounts_device_poll", arguments: { provider: "codex", deviceCode: "dc-1" } });
  expect(polled.isError).toBeFalsy();
  expect((dataOf(polled) as { data: { status: string } }).data.status).toBe("pending");
});

test("analytics_overview_read reports usage totals", async () => {
  const client = await connect(contextWith(), authInfoWith({ userId: "user-1" }));
  const result = await client.callTool({ name: "analytics_overview_read", arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(dataOf(result)).toEqual({ requests: 5, successRate: 100 });
});

test("providers_list returns custom providers", async () => {
  const client = await connect(contextWith(), authInfoWith({ userId: "user-1" }));
  const result = await client.callTool({ name: "providers_list", arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(dataOf(result)).toEqual([{ slug: "local", name: "Local" }]);
});

test("session_read combines points and sharing", async () => {
  const client = await connect(contextWith(), authInfoWith({ userId: "user-1" }));
  const result = await client.callTool({ name: "session_read", arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(dataOf(result)).toEqual({
    userId: "user-1",
    points: { balance: 42, roamingByKey: { "key-1": 3 } },
    sharing: { enabled: false },
  });
});

test("sharing_update flips the sharing flag", async () => {
  const client = await connect(contextWith(), authInfoWith({ userId: "user-1" }));
  const result = await client.callTool({ name: "sharing_update", arguments: { enabled: true } });
  expect(result.isError).toBeFalsy();
  expect(dataOf(result)).toEqual({ enabled: true });
});

test("find_operations ranks tools by keyword relevance", async () => {
  const client = await connect(contextWith(), ANONYMOUS);
  const result = await client.callTool({ name: "find_operations", arguments: { query: "check my balance points", limit: 3 } });
  expect(result.isError).toBeFalsy();
  const tools = (dataOf(result) as { tools: Array<{ name: string }> }).tools;
  expect(tools.length).toBeGreaterThan(0);
  expect(tools[0].name).toBe("billing_balance_read");
});

test("context_read inventories the server for the identity", async () => {
  const client = await connect(contextWith(), authInfoWith({ userId: "user-1" }));
  const result = await client.callTool({ name: "context_read", arguments: {} });
  expect(result.isError).toBeFalsy();
  const data = dataOf(result) as { server: string; userId: string; toolCount: number; tools: string[] };
  expect(data.server).toBe("opendum-mcp");
  expect(data.userId).toBe("user-1");
  expect(data.toolCount).toBe(data.tools.length);
  expect(data.tools).toContain("chat_create");
});

test("user-scoped tools reject anonymous identities with a tool error", async () => {
  const client = await connect(contextWith(), ANONYMOUS);
  const result = await client.callTool({ name: "apiKeys_list", arguments: {} });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("No authenticated user");
});

test("web service failures surface as tool errors with the service message", async () => {
  const web = {
    ...DEFAULT_WEB,
    apiKeys: { ...DEFAULT_WEB.apiKeys, listApiKeys: () => Effect.fail({ message: "db down", status: 500 }) },
  };
  const client = await connect(contextWith({ web }), authInfoWith({ userId: "user-1" }));
  const result = await client.callTool({ name: "apiKeys_list", arguments: {} });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("db down");
});

test("invalid identity in authInfo is still rejected at the catalog level", async () => {
  const context = contextWith({
    auth: { ...DEFAULT_AUTH, validateKey: () => Effect.succeed(emptyResult("Invalid API key")) },
  });
  const client = await connect(context, authInfoWith({ userId: "user-1" }));
  const result = await client.callTool({ name: "models_list", arguments: {} });
  expect(result.isError).toBeFalsy();
});
