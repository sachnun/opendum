import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { WORKBUDDY_BASE_URL, WORKBUDDY_DOMAIN } from "@opendum/providers/auth/workbuddy/constants";
import type { UpstreamTransport } from "@opendum/providers/http";
import type { ProviderAccount } from "@opendum/providers/types";
import { WorkbuddyProvider, fromStream } from "@opendum/providers/upstreams/workbuddy/index";

const account = { id: "acc-1" } as unknown as ProviderAccount;
const FALLBACK_TTL_MS = 31536000 * 1000;

const UUID_V7_HEX = /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/;
const CONVERSATION_HEADERS = [
  "X-Conversation-ID",
  "X-Conversation-Request-ID",
  "X-Conversation-Message-ID",
  "X-Request-ID",
];

type Captured = { url: string; init?: RequestInit };

function provider(response: { status?: number; body: string }, captured?: Captured[]): WorkbuddyProvider {
  const direct = async (url: string, init?: RequestInit): Promise<Response> => {
    captured?.push({ url, init });
    return new Response(response.body, { status: response.status ?? 200 });
  };
  const transport: UpstreamTransport = { direct, egress: null, egressReady: () => false };
  const registry = { upstream: (name: string) => name } as unknown as Registry;
  return new WorkbuddyProvider({ registry, transport });
}

async function refresh(buddy: WorkbuddyProvider, refreshToken = "rt-1") {
  return Effect.runPromise(
    buddy.refreshCredentials(refreshToken, account).pipe(
      Effect.map((credentials) => ({ ok: true as const, credentials })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error }))
    )
  );
}

describe("WorkbuddyProvider.refreshCredentials", () => {
  it("calls the refresh endpoint with the trim token and parses the payload", async () => {
    const captured: Captured[] = [];
    const fake = provider({ body: JSON.stringify({ code: 0, data: { accessToken: " at-1 ", refreshToken: " rt-2 ", expiresIn: 120 } }) }, captured);
    const before = Date.now();
    const result = await refresh(fake, "  rt-1  ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credentials.accessToken).toBe("at-1");
      expect(result.credentials.refreshToken).toBe("rt-2");
      expect(result.credentials.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 120 * 1000);
      expect(result.credentials.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 121 * 1000);
    }
    expect(captured[0]?.url).toBe(`${WORKBUDDY_BASE_URL}/v2/plugin/auth/token/refresh`);
    const headers = captured[0]?.init?.headers as Record<string, string>;
    expect(headers["X-Refresh-Token"]).toBe("rt-1");
    expect(headers["X-Domain"]).toBe(WORKBUDDY_DOMAIN);
    expect(headers["X-Auth-Refresh-Source"]).toBe("plugin");
    expect(captured[0]?.init?.body).toBe("{}");
  });

  it("keeps the stored refresh token when the response omits one", async () => {
    const result = await refresh(provider({ body: JSON.stringify({ code: 0, data: { accessToken: "at-1" } }) }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credentials.refreshToken).toBe("rt-1");
  });

  it("accepts expiresAt in seconds and in milliseconds", async () => {
    const seconds = await refresh(provider({ body: JSON.stringify({ code: 0, data: { accessToken: "at", expiresAt: 1700000000 } }) }));
    expect(seconds.ok).toBe(true);
    if (seconds.ok) expect(seconds.credentials.expiresAt.getTime()).toBe(1700000000 * 1000);
    const millis = await refresh(provider({ body: JSON.stringify({ code: 0, data: { accessToken: "at", expiresAt: 1700000000000 } }) }));
    expect(millis.ok).toBe(true);
    if (millis.ok) expect(millis.credentials.expiresAt.getTime()).toBe(1700000000000);
  });

  it("falls back to the long default TTL without expiry hints", async () => {
    const before = Date.now();
    const result = await refresh(provider({ body: JSON.stringify({ code: 0, data: { accessToken: "at" } }) }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credentials.expiresAt.getTime()).toBeGreaterThanOrEqual(before + FALLBACK_TTL_MS);
  });

  it("fails with the provider label on non-2xx responses", async () => {
    const result = await refresh(provider({ status: 500, body: "boom" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.provider).toBe("workbuddy");
      expect(result.error.message).toBe("workbuddy token refresh failed: 500 boom");
    }
  });

  it("rejects responses with a non-zero code or empty token", async () => {
    const badCode = await refresh(provider({ body: JSON.stringify({ code: 7, data: { accessToken: "at" } }) }));
    expect(badCode.ok).toBe(false);
    if (!badCode.ok) expect(badCode.error.message).toBe("workbuddy token refresh returned empty token");
    const emptyToken = await refresh(provider({ body: JSON.stringify({ code: 0, data: { accessToken: "  " } }) }));
    expect(emptyToken.ok).toBe(false);
    if (!emptyToken.ok) expect(emptyToken.error.message).toBe("workbuddy token refresh returned empty token");
  });
});

type ChatOptions = {
  accountId?: string;
  sessionId?: string;
  requestId?: string;
  messages?: unknown[];
  body?: Record<string, unknown>;
};

async function chat(buddy: WorkbuddyProvider, options: ChatOptions = {}): Promise<void> {
  await Effect.runPromise(
    buddy.makeRequest({
      account: { id: "acc-1", accountId: options.accountId ?? "user-1" } as unknown as ProviderAccount,
      credentials: "at-1",
      body: {
        model: "deepseek-v4.1-flash",
        messages: options.messages ?? [{ role: "user", content: "hi" }],
        ...options.body,
      },
      stream: true,
      sessionId: options.sessionId,
      requestId: options.requestId,
    })
  );
}

function requestBody(captured: Captured[]): Record<string, unknown> {
  return JSON.parse(String(captured[0]?.init?.body)) as Record<string, unknown>;
}

describe("WorkbuddyProvider.makeRequest", () => {
  it("keeps the conversation id stable for a session and refreshes message ids per call", async () => {
    const captured: Captured[] = [];
    const fake = provider({ body: "" }, captured);
    const turnId = "018f5c8a1e2f7abc8def0123456789ab";
    await chat(fake, { sessionId: "session-1", requestId: turnId });
    await chat(fake, { sessionId: "session-1", requestId: turnId });
    const first = captured[0]?.init?.headers as Record<string, string>;
    const second = captured[1]?.init?.headers as Record<string, string>;
    expect(first["X-Conversation-ID"]).toMatch(UUID_V7_HEX);
    expect(second["X-Conversation-ID"]).toBe(first["X-Conversation-ID"]);
    expect(first["X-Conversation-Request-ID"]).toBe(turnId);
    expect(second["X-Conversation-Request-ID"]).toBe(turnId);
    expect(first["X-Request-ID"]).toBe(first["X-Conversation-Message-ID"]);
    expect(first["X-Conversation-Message-ID"]).toMatch(UUID_V7_HEX);
    for (const name of CONVERSATION_HEADERS) {
      expect(second[name]).toMatch(UUID_V7_HEX);
    }
    expect(second["X-Conversation-Message-ID"]).not.toBe(first["X-Conversation-Message-ID"]);
    expect(second["X-Request-ID"]).not.toBe(first["X-Request-ID"]);
  });

  it("derives the conversation id from the account and the first user message without a session", async () => {
    const captured: Captured[] = [];
    const fake = provider({ body: "" }, captured);
    await chat(fake);
    await chat(fake);
    await chat(fake, { accountId: "user-2" });
    const first = captured[0]?.init?.headers as Record<string, string>;
    const second = captured[1]?.init?.headers as Record<string, string>;
    const third = captured[2]?.init?.headers as Record<string, string>;
    expect(first["X-Conversation-ID"]).toMatch(UUID_V7_HEX);
    expect(second["X-Conversation-ID"]).toBe(first["X-Conversation-ID"]);
    expect(third["X-Conversation-ID"]).not.toBe(first["X-Conversation-ID"]);
    expect(second["X-Conversation-Request-ID"]).toMatch(UUID_V7_HEX);
    expect(second["X-Conversation-Request-ID"]).not.toBe(first["X-Conversation-Request-ID"]);
  });

  it("sends the canonical workbuddy client headers", async () => {
    const captured: Captured[] = [];
    const fake = provider({ body: "" }, captured);
    await chat(fake, { sessionId: "session-1" });
    const headers = captured[0]?.init?.headers as Record<string, string>;
    expect(headers["X-User-Id"]).toBe("user-1");
    expect(headers["X-Domain"]).toBe(WORKBUDDY_DOMAIN);
    expect(headers.Authorization).toBe("Bearer at-1");
    expect(headers["X-Agent-Intent"]).toBe("craft");
    expect(headers["X-Agent-Purpose"]).toBe("conversation");
    expect(headers["X-Agent-Type"]).toBe("main");
    expect(headers["X-IDE-Type"]).toBe("WorkBuddy");
    expect(headers["X-IDE-Name"]).toBe("WorkBuddy");
    expect(headers["X-IDE-Version"]).toBe("5.8.4");
    expect(headers["X-Product"]).toBe("SaaS");
    expect(headers["X-Private-Data"]).toBe("true");
    expect(headers["x-requested-with"]).toBe("XMLHttpRequest");
    expect(headers["x-codebuddy-request"]).toBe("1");
    expect(headers["x-stainless-lang"]).toBe("js");
    expect(headers["x-stainless-package-version"]).toBe("6.25.0");
    expect(headers["x-stainless-runtime"]).toBe("node");
    expect(headers["X-Agent-Runtime"]).toBe("other");
    expect(headers["User-Agent"]).toBe("WorkBuddy/5.8.4 WorkBuddy/5.8.4 CLI/2.161.0");
    expect(headers.Accept).toBe("text/event-stream");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers.b3).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/);
    expect(headers["X-B3-TraceId"]).toBe(headers["X-Trace-ID"]);
    expect(headers["X-B3-Sampled"]).toBe("1");
    expect(headers["X-Root-Request-ID"]).toBe(headers["X-Conversation-Request-ID"]);
    expect(headers["acp-connection-id"]).toMatch(UUID_V7_HEX);
    expect(headers.baggage).toContain(`codebuddy.session_id=${headers["X-Conversation-ID"]}`);
    expect(headers.baggage).toContain(`codebuddy.conversation_request_id=${headers["X-Conversation-Request-ID"]}`);
  });

  it("rewrites the Claude Code channel fingerprint in system content", async () => {
    const captured: Captured[] = [];
    const fake = provider({ body: "" }, captured);
    await chat(fake, {
      messages: [
        { role: "developer", content: "You are Claude Code, Anthropic's official CLI for Claude." },
        { role: "user", content: "hi" },
      ],
    });
    const messages = requestBody(captured).messages as Array<Record<string, unknown>>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toBe("You are Claude Code, Anthropic official CLI for Claude.");
    expect(messages[1]?.role).toBe("user");
  });

  it("drops the Main branch PR hint from system content", async () => {
    const captured: Captured[] = [];
    const fake = provider({ body: "" }, captured);
    await chat(fake, {
      messages: [
        { role: "system", content: "Main branch (you will usually use this for PRs)" },
        { role: "user", content: "hi" },
      ],
    });
    const messages = requestBody(captured).messages as Array<Record<string, unknown>>;
    expect(messages[0]?.content).toBe("Main branch");
  });

  it("keeps the acp connection id sticky for a session", async () => {
    const captured: Captured[] = [];
    const fake = provider({ body: "" }, captured);
    await chat(fake, { sessionId: "session-1" });
    await chat(fake, { sessionId: "session-1" });
    const first = captured[0]?.init?.headers as Record<string, string>;
    const second = captured[1]?.init?.headers as Record<string, string>;
    expect(first["acp-connection-id"]).toMatch(UUID_V7_HEX);
    expect(second["acp-connection-id"]).toBe(first["acp-connection-id"]);
  });

  it("keeps the conversation headers off the refresh call", async () => {
    const captured: Captured[] = [];
    const fake = provider({ body: JSON.stringify({ code: 0, data: { accessToken: "at" } }) }, captured);
    const result = await refresh(fake);
    expect(result.ok).toBe(true);
    const headers = captured[0]?.init?.headers as Record<string, string>;
    for (const name of CONVERSATION_HEADERS) expect(headers[name]).toBeUndefined();
  });

  it("parses tool definitions sent as a JSON string", async () => {
    const captured: Captured[] = [];
    const fake = provider({ body: "" }, captured);
    const tools = [{ type: "function", function: { name: "read", parameters: { type: "object" } } }];
    await chat(fake, { body: { tools: JSON.stringify(tools), tool_choice: "auto" } });
    const body = requestBody(captured);
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe("auto");
  });

  it("drops tools that cannot be parsed instead of forwarding a string", async () => {
    const captured: Captured[] = [];
    const fake = provider({ body: "" }, captured);
    await chat(fake, { body: { tools: "[5 tool(s): read, bash]", tool_choice: "auto" } });
    const body = requestBody(captured);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("drops tools that are not an array or hold no objects", async () => {
    const notArray: Captured[] = [];
    await chat(provider({ body: "" }, notArray), { body: { tools: { type: "function" }, tool_choice: "auto" } });
    expect(requestBody(notArray).tools).toBeUndefined();
    expect(requestBody(notArray).tool_choice).toBeUndefined();
    const primitives: Captured[] = [];
    await chat(provider({ body: "" }, primitives), { body: { tools: ["read", "bash"] } });
    expect(requestBody(primitives).tools).toBeUndefined();
  });

  it("keeps object tool entries and skips primitives in a mixed array", async () => {
    const captured: Captured[] = [];
    const fake = provider({ body: "" }, captured);
    const entry = { type: "function", function: { name: "read" } };
    await chat(fake, { body: { tools: [entry, "bash", null] } });
    expect(requestBody(captured).tools).toEqual([entry]);
  });

  it("forwards array tools with tool_choice untouched", async () => {
    const captured: Captured[] = [];
    const fake = provider({ body: "" }, captured);
    const tools = [{ type: "function", function: { name: "edit" } }];
    await chat(fake, { body: { tools, tool_choice: { type: "function", function: { name: "edit" } } } });
    const body = requestBody(captured);
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "edit" } });
  });
});

describe("fromStream", () => {
  it("aggregates content, reasoning and tool call fragments", () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"he"}}]}',
      'data: {"choices":[{"delta":{"content":[{"type":"text","text":"llo"}],"reasoning_content":" why"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":"{\\"q\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}',
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}',
      "data: [DONE]",
    ].join("\n");

    const completion = fromStream(sse, "gpt-5.1-codex");
    expect(completion.id).toBe("chatcmpl-workbuddy");
    expect(completion.model).toBe("gpt-5.1-codex");
    const choice = (completion.choices as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const message = choice.message as Record<string, unknown>;
    expect(message.content).toBe("hello why");
    expect(message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } },
    ]);
    expect(choice.finish_reason).toBe("tool_calls");
    expect(completion.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  });

  it("upgrades a stop finish reason when tool calls are present", () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":2,"function":{"name":"f","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ].join("\n");

    const completion = fromStream(sse, "m");
    const choice = (completion.choices as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const message = choice.message as Record<string, unknown>;
    expect(choice.finish_reason).toBe("tool_calls");
    expect((message.tool_calls as Array<Record<string, unknown>>)[0]?.id).toBe("call_2");
  });
});
