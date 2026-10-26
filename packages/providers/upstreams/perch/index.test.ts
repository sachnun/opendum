import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { PERCH_APP_URL, PERCH_CONFIG_PATH } from "@opendum/providers/auth/perch/constants";
import type { UpstreamTransport } from "@opendum/providers/core/http";
import type { ProviderAccount } from "@opendum/providers/types";
import { PerchProvider } from "@opendum/providers/upstreams/perch/index";
import { PerchCompletion } from "@opendum/providers/upstreams/perch/stream";

const account = { id: "acc-1" } as unknown as ProviderAccount;
const SUPABASE_URL = "https://perch-supabase.test";
const CONFIG_ENDPOINT = `${PERCH_APP_URL}${PERCH_CONFIG_PATH}`;
const TOKEN_ENDPOINT = `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`;

type Captured = { url: string; init?: RequestInit };

function provider(response: { status?: number; body: string }, captured?: Captured[]): PerchProvider {
  const direct = async (url: string, init?: RequestInit): Promise<Response> => {
    captured?.push({ url, init });
    if (url === CONFIG_ENDPOINT) {
      return new Response(JSON.stringify({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: "anon-1" }), { status: 200 });
    }
    return new Response(response.body, { status: response.status ?? 200 });
  };
  const transport: UpstreamTransport = { direct, egress: null, egressReady: () => false };
  const registry = { upstream: (name: string) => name } as unknown as Registry;
  return new PerchProvider({ registry, transport });
}

function tokenCall(captured: Captured[]): Captured | undefined {
  return captured.find((call) => call.url === TOKEN_ENDPOINT);
}

async function refresh(perch: PerchProvider, refreshToken = "rt-1") {
  return Effect.runPromise(
    perch.refreshCredentials(refreshToken, account).pipe(
      Effect.map((credentials) => ({ ok: true as const, credentials })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error }))
    )
  );
}

describe("PerchProvider.refreshCredentials", () => {
  it("resolves the supabase endpoint and posts the refresh token", async () => {
    const captured: Captured[] = [];
    const fake = provider(
      { body: JSON.stringify({ access_token: " at-1 ", refresh_token: " rt-2 ", expires_in: 900 }) },
      captured
    );
    const before = Date.now();
    const result = await refresh(fake, "  rt-1  ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credentials.accessToken).toBe("at-1");
      expect(result.credentials.refreshToken).toBe("rt-2");
      expect(result.credentials.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 900 * 1000);
    }
    const call = tokenCall(captured);
    expect(call?.init?.method).toBe("POST");
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers.apikey).toBe("anon-1");
    expect(headers.Authorization).toBe("Bearer anon-1");
    expect(JSON.parse(String(call?.init?.body))).toEqual({ refresh_token: "rt-1" });
  });

  it("keeps the stored refresh token and defaults to one hour", async () => {
    const before = Date.now();
    const result = await refresh(provider({ body: JSON.stringify({ access_token: "at-1" }) }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credentials.refreshToken).toBe("rt-1");
      expect(result.credentials.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    }
  });

  it("prefers expires_at over expires_in", async () => {
    const result = await refresh(
      provider({ body: JSON.stringify({ access_token: "at", expires_at: 1700000000, expires_in: 900 }) })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credentials.expiresAt.getTime()).toBe(1700000000 * 1000);
  });

  it("fails with the provider label on non-2xx responses", async () => {
    const result = await refresh(provider({ status: 401, body: "nope" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.provider).toBe("perch");
      expect(result.error.message).toBe("perch token refresh failed: 401 nope");
    }
  });

  it("rejects empty access tokens", async () => {
    const result = await refresh(provider({ body: JSON.stringify({ access_token: "  " }) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("perch token refresh returned empty access token");
  });
});

function sse(...events: Array<Record<string, unknown>>): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}`).join("\n"));
}

function choiceOf(completion: Record<string, unknown>): { message: Record<string, unknown>; finishReason: string } {
  const choice = (completion.choices as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  return { message: choice.message as Record<string, unknown>, finishReason: choice.finish_reason as string };
}

describe("perchSseToChatCompletion", () => {
  it("aggregates answer, reasoning and tool call events", async () => {
    const completion = await PerchCompletion.fromResponse(
      sse(
        { type: "reasoning_delta", text: " think" },
        { type: "answer_delta", text: "he" },
        { type: "answer_delta", text: "llo" },
        {
          type: "tool_call_delta",
          toolCalls: [{ id: "call_1", name: "search", rawArgumentsText: '{"q":' }],
        },
        { type: "tool_use_end", toolCalls: [{ id: "call_1", arguments: { q: "x" } }] },
        { type: "done", ok: true, usage: { inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 1 } }
      ),
      "perch-model",
      true
    );

    expect(completion.id).toMatch(/^chatcmpl/);
    expect(completion.model).toBe("perch-model");
    const { message, finishReason } = choiceOf(completion);
    expect(message.content).toBe("hello");
    expect(message.reasoning_content).toBe(" think");
    expect(message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } },
    ]);
    expect(finishReason).toBe("tool_calls");
    expect(completion.usage).toEqual({
      prompt_tokens: 4,
      completion_tokens: 4,
      total_tokens: 8,
      prompt_tokens_details: { cached_tokens: 1 },
    });
  });

  it("drops reasoning, nulls empty content and defaults blank arguments", async () => {
    const completion = await PerchCompletion.fromResponse(
      sse(
        { type: "reasoning_delta", text: "hmm" },
        { type: "tool_call_delta", toolCalls: [{ id: "call_2", name: "f", rawArgumentsText: "  " }] },
        { type: "done", ok: true }
      ),
      "m",
      false
    );

    const { message, finishReason } = choiceOf(completion);
    expect(message.content).toBeNull();
    expect(message.reasoning_content).toBeUndefined();
    expect((message.tool_calls as Array<Record<string, unknown>>)[0]).toEqual({
      id: "call_2",
      type: "function",
      function: { name: "f", arguments: "{}" },
    });
    expect(finishReason).toBe("tool_calls");
    expect(completion.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it("fails on rejected done events", async () => {
    await expect(
      PerchCompletion.fromResponse(sse({ type: "done", ok: false, error: "quota exceeded" }), "m", false)
    ).rejects.toThrow("quota exceeded");
  });
});
