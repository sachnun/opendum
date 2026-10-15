import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { WORKBUDDY_BASE_URL, WORKBUDDY_DOMAIN } from "../endpoints.js";
import type { UpstreamTransport } from "../core/http.js";
import type { ProviderAccount } from "../types.js";
import { WorkbuddyProvider, workbuddyStreamToCompletion } from "./workbuddy.js";

const account = { id: "acc-1" } as unknown as ProviderAccount;
const FALLBACK_TTL_MS = 31536000 * 1000;

type Captured = { url: string; init?: RequestInit };

function provider(response: { status?: number; body: string }, captured?: Captured[]): WorkbuddyProvider {
  const direct = async (url: string, init?: RequestInit): Promise<Response> => {
    captured?.push({ url, init });
    return new Response(response.body, { status: response.status ?? 200 });
  };
  const transport: UpstreamTransport = { direct, egress: null, egressReady: () => false };
  const registry = { upstreamModelName: (name: string) => name } as unknown as Registry;
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

describe("workbuddyStreamToCompletion", () => {
  it("aggregates content, reasoning and tool call fragments", () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"he"}}]}',
      'data: {"choices":[{"delta":{"content":[{"type":"text","text":"llo"}],"reasoning_content":" why"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":"{\\"q\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}',
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}',
      "data: [DONE]",
    ].join("\n");

    const completion = workbuddyStreamToCompletion(sse, "gpt-5.1-codex");
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

    const completion = workbuddyStreamToCompletion(sse, "m");
    const choice = (completion.choices as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const message = choice.message as Record<string, unknown>;
    expect(choice.finish_reason).toBe("tool_calls");
    expect((message.tool_calls as Array<Record<string, unknown>>)[0]?.id).toBe("call_2");
  });
});
