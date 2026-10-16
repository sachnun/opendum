import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";
import { CODEX_CLIENT_ID, CODEX_TOKEN_ENDPOINT } from "../endpoints.js";
import type { UpstreamTransport } from "../core/http.js";
import type { ProviderAccount } from "../types.js";
import { CodexProvider, responsesStreamToCompletion } from "./codex.js";

const account = { id: "acc-1" } as unknown as ProviderAccount;

type Captured = { url: string; init?: RequestInit };

function jwt(claims: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
}

function provider(response: { status?: number; body: string }, captured?: Captured[]): CodexProvider {
  const direct = async (url: string, init?: RequestInit): Promise<Response> => {
    captured?.push({ url, init });
    return new Response(response.body, { status: response.status ?? 200 });
  };
  const transport: UpstreamTransport = { direct, egress: null, egressReady: () => false };
  const registry = { upstream: (name: string) => name } as unknown as Registry;
  return new CodexProvider({ registry, transport });
}

async function refresh(codex: CodexProvider, refreshToken = "rt-1") {
  return Effect.runPromise(
    codex.refreshCredentials(refreshToken, account).pipe(
      Effect.map((credentials) => ({ ok: true as const, credentials })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error }))
    )
  );
}

describe("CodexProvider.refreshCredentials", () => {
  it("posts the form body and reads tier and account from the JWTs", async () => {
    const captured: Captured[] = [];
    const accessToken = jwt({ chatgpt_account_id: "acc-1" });
    const idToken = jwt({ chatgpt_plan_type: "Plus" });
    const fake = provider(
      { body: JSON.stringify({ access_token: accessToken, refresh_token: "rt-2", expires_in: 1800, id_token: idToken }) },
      captured
    );
    const before = Date.now();
    const result = await refresh(fake, "  rt-1  ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credentials.accessToken).toBe(accessToken);
      expect(result.credentials.refreshToken).toBe("rt-2");
      expect(result.credentials.accountId).toBe("acc-1");
      expect(result.credentials.tier).toBe("plus");
      expect(result.credentials.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 1800 * 1000);
    }
    expect(captured[0]?.url).toBe(CODEX_TOKEN_ENDPOINT);
    const headers = captured[0]?.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(captured[0]?.init?.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt-1");
    expect(form.get("client_id")).toBe(CODEX_CLIENT_ID);
  });

  it("falls back to the id token for the account id and defaults the expiry", async () => {
    const before = Date.now();
    const result = await refresh(
      provider({ body: JSON.stringify({ access_token: jwt({}), id_token: jwt({ chatgpt_account_id: "acc-9" }) }) }),
      "rt-1"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credentials.accountId).toBe("acc-9");
      expect(result.credentials.refreshToken).toBe("rt-1");
      expect(result.credentials.tier).toBe("");
      expect(result.credentials.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
    }
  });

  it("reads the tier from the access token when no id token is present", async () => {
    const result = await refresh(provider({ body: JSON.stringify({ access_token: jwt({ chatgpt_plan_type: "Pro" }) }) }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credentials.tier).toBe("pro");
  });

  it("fails with the provider label on non-2xx responses", async () => {
    const result = await refresh(provider({ status: 429, body: "busy" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.provider).toBe("codex");
      expect(result.error.message).toBe("codex token refresh failed: 429 busy");
    }
  });

  it("rejects empty access tokens", async () => {
    const result = await refresh(provider({ body: JSON.stringify({ access_token: "" }) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("codex token refresh returned empty access token");
  });
});

function sse(...events: Array<Record<string, unknown>>): string {
  return events.map((event) => `data: ${JSON.stringify(event)}`).join("\n");
}

function choiceOf(completion: Record<string, unknown>): { message: Record<string, unknown>; finishReason: string } {
  const choice = (completion.choices as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  return { message: choice.message as Record<string, unknown>, finishReason: choice.finish_reason as string };
}

describe("responsesStreamToCompletion", () => {
  it("aggregates text, reasoning, tool calls and usage", () => {
    const completion = responsesStreamToCompletion(
      sse(
        { type: "response.output_text.delta", delta: "he" },
        { type: "response.output_text.delta", delta: "llo" },
        { type: "response.reasoning_summary_text.delta", summary_index: 0, delta: "why" },
        { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "search" } },
        { type: "response.function_call_arguments.delta", delta: '{"q":' },
        { type: "response.function_call_arguments.delta", delta: '"x"}' },
        { type: "response.function_call_arguments.done" },
        {
          type: "response.completed",
          response: { status: "completed", usage: { input_tokens: 3, output_tokens: 4 } },
        }
      ),
      "gpt-5.1-codex"
    );

    expect(completion.id).toMatch(/^chatcmpl/);
    expect(completion.model).toBe("gpt-5.1-codex");
    const { message, finishReason } = choiceOf(completion);
    expect(message.content).toBe("hello");
    expect(message.reasoning_content).toBe("why");
    expect(message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } },
    ]);
    expect(finishReason).toBe("tool_calls");
    expect(completion.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  });

  it("maps an incomplete response without tools to a length finish reason", () => {
    const completion = responsesStreamToCompletion(
      sse({ type: "response.completed", response: { status: "incomplete" } }),
      "m"
    );

    const { message, finishReason } = choiceOf(completion);
    expect(message.content).toBeNull();
    expect(finishReason).toBe("length");
    expect(completion.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it("prefers tool calls over a length finish reason", () => {
    const completion = responsesStreamToCompletion(
      sse(
        { type: "response.output_item.added", item: { type: "function_call", id: "fc_2", name: "f" } },
        { type: "response.function_call_arguments.done" },
        { type: "response.completed", response: { status: "incomplete" } }
      ),
      "m"
    );

    const { message, finishReason } = choiceOf(completion);
    expect(finishReason).toBe("tool_calls");
    expect((message.tool_calls as Array<Record<string, unknown>>)[0]).toEqual({
      id: "call_2",
      type: "function",
      function: { name: "f", arguments: "{}" },
    });
  });
});
