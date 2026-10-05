import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/redis";
import { CodexProvider, responsesStreamToCompletion } from "#providers/providers/codex/provider.ts";
import { createTransport } from "#providers/api/http.ts";
import type { FetchLike } from "#providers/api/http.ts";
import type { ProviderAccount, ProviderRequest } from "#providers/model/types.ts";

type Json = Record<string, unknown>;

function registry(): Registry {
  return {
    providerModelMap: () => new Map([["gpt-5", "gpt-5-codex"]]),
    upstreamModelName: (model: string) => model,
  } as unknown as Registry;
}

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id: "a1", userId: "u1", provider: "codex", ...overrides };
}

function request(body: Json, credentials = "tok", stream = false): ProviderRequest {
  return { account: account(), credentials, body, stream };
}

function recorder(response: Response): { calls: Array<{ url: string; init?: RequestInit }>; fetch: FetchLike } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response;
    },
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function jwt(payload: Json): string {
  return `header.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.sig`;
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("CodexProvider credentials", () => {
  it("exposes the refresh buffer", () => {
    const provider = new CodexProvider({ registry: registry(), transport: createTransport(async () => new Response("{}")) });
    assert.equal(provider.refreshBuffer(), 5 * 60 * 1000);
  });

  it("refreshes credentials and reads jwt claims", async () => {
    const fetch: FetchLike = async () =>
      new Response(
        JSON.stringify({
          access_token: jwt({ chatgpt_account_id: "acc1" }),
          refresh_token: "rt2",
          expires_in: 120,
          id_token: jwt({ chatgpt_plan_type: "Plus" }),
        }),
        { status: 200 }
      );
    const provider = new CodexProvider({ registry: registry(), transport: createTransport(fetch) });
    const refreshed = await provider.refreshCredentials("rt1", account());
    assert.equal(refreshed.accessToken.startsWith("header."), true);
    assert.equal(refreshed.refreshToken, "rt2");
    assert.equal(refreshed.accountId, "acc1");
    assert.equal(refreshed.tier, "plus");
  });

  it("reads account ids and tiers from id tokens", async () => {
    const fetch: FetchLike = async () =>
      new Response(
        JSON.stringify({
          access_token: jwt({}),
          refresh_token: "rt2",
          expires_in: 120,
          id_token: jwt({ chatgpt_account_id: "acc2", chatgpt_plan_type: "Pro" }),
        }),
        { status: 200 }
      );
    const provider = new CodexProvider({ registry: registry(), transport: createTransport(fetch) });
    const refreshed = await provider.refreshCredentials("rt1", account());
    assert.equal(refreshed.accountId, "acc2");
    assert.equal(refreshed.tier, "pro");
  });

  it("extracts workspace and organization claims", async () => {
    const workspace = new CodexProvider({
      registry: registry(),
      transport: createTransport(async () => json({ access_token: jwt({ "https://api.openai.com/auth": { chatgpt_workspace_id: "ws1" } }) })),
    });
    assert.equal((await workspace.refreshCredentials("rt", account())).accountId, "ws1");

    const organization = new CodexProvider({
      registry: registry(),
      transport: createTransport(async () => json({ access_token: jwt({ organizations: [{ id: "org1" }, { id: "org2", is_default: true }] }) })),
    });
    assert.equal((await organization.refreshCredentials("rt", account())).accountId, "org2");
  });

  it("rejects failed refreshes", async () => {
    const provider = new CodexProvider({
      registry: registry(),
      transport: createTransport(async () => new Response("nope", { status: 400 })),
    });
    await assert.rejects(provider.refreshCredentials("rt", account()), /token refresh failed/);

    const empty = new CodexProvider({
      registry: registry(),
      transport: createTransport(async () => new Response(JSON.stringify({ access_token: "" }), { status: 200 })),
    });
    await assert.rejects(empty.refreshCredentials("rt", account()), /empty access token/);
  });
});

describe("CodexProvider.makeRequest", () => {
  it("rejects unsupported models", async () => {
    const provider = new CodexProvider({ registry: registry(), transport: createTransport(async () => new Response("{}")) });
    const resp = await provider.makeRequest(request({ model: "nope" }));
    assert.equal(resp.status, 400);
    const json = (await resp.json()) as Json;
    assert.equal((json.error as Json).code, "unsupported_codex_chatgpt_model");
  });

  it("posts responses requests and streams chat chunks", async () => {
    const fetch = async () =>
      new Response(sseStream(['data: {"type":"response.output_text.delta","delta":"hi"}\n\ndata: [DONE]\n']), { status: 200 });
    const provider = new CodexProvider({ registry: registry(), transport: createTransport(fetch) });
    const resp = await provider.makeRequest(request({ model: "gpt-5", messages: [] }, "tok", true));
    assert.equal(resp.headers.get("content-type"), "text/event-stream");
    const text = await resp.text();
    assert.match(text, /"content":"hi"/);
  });

  it("converts non-streaming responses and forwards account ids", async () => {
    const direct = recorder(
      new Response('data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1}}}\n', {
        status: 200,
      })
    );
    const accountIds: string[] = [];
    const provider = new CodexProvider({
      registry: registry(),
      transport: createTransport(direct.fetch),
      onAccountId: (id) => accountIds.push(id),
    });
    const credentials = jwt({ chatgpt_account_id: "acc9" });
    const resp = await provider.makeRequest(request({ model: "gpt-5", messages: [] }, credentials, false));
    assert.equal(resp.status, 200);
    const headers = direct.calls[0]!.init!.headers as Record<string, string>;
    assert.equal(headers["ChatGPT-Account-Id"], "acc9");
    assert.equal(headers.session_id, undefined);
    assert.deepEqual(accountIds, ["acc9"]);
  });

  it("builds rich payloads and caches sessions", async () => {
    const direct = recorder(new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n', { status: 200 }));
    const provider = new CodexProvider({ registry: registry(), transport: createTransport(direct.fetch) });
    await provider.makeRequest(
      request({
        model: "gpt-5",
        messages: [{ role: "system", content: "s" }],
        instructions: "ins",
        tools: [{ type: "function", function: { name: "f", parameters: {} } }],
        parallel_tool_calls: true,
        reasoning: { effort: "low" },
        previous_response_id: "p",
        service_tier: "auto",
        _sessionId: "sess",
        _responsesInput: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      })
    );
    const payload = JSON.parse(direct.calls[0]!.init!.body as string) as Json;
    assert.equal(payload.instructions, "ins");
    assert.equal(payload.tool_choice, "auto");
    assert.equal(payload.parallel_tool_calls, true);
    assert.deepEqual(payload.reasoning, { effort: "low" });
    assert.equal(payload.previous_response_id, "p");
    assert.equal(payload.service_tier, "auto");
    assert.equal(payload.prompt_cache_key, "sess");
    assert.deepEqual(payload.client_metadata, { session_id: "sess" });
  });

  it("returns upstream errors and records quota headers", async () => {
    const errorProvider = new CodexProvider({
      registry: registry(),
      transport: createTransport(async () => new Response("bad", { status: 500 })),
    });
    assert.equal((await errorProvider.makeRequest(request({ model: "gpt-5", messages: [] }))).status, 500);

    const sets: Array<{ key: string; value: string }> = [];
    const redis = {
      set: async (key: string, value: string) => {
        sets.push({ key, value });
      },
    } as unknown as OpendumRedis;
    const provider = new CodexProvider({
      registry: registry(),
      transport: createTransport(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "x-codex-primary-used-percent": "50", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": "1700000000" },
          })
      ),
      redis,
    });
    await provider.makeRequest(request({ model: "gpt-5", messages: [] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sets.length, 1);
    assert.match(sets[0]!.key, /codex:snapshot:a1/);
    const snapshot = JSON.parse(sets[0]!.value) as Json;
    assert.equal((snapshot.primary as Json).usedPercent, 50);
  });
});

describe("responsesStreamToCompletion", () => {
  it("aggregates text, reasoning and tool calls", () => {
    const text = [
      'data: {"type":"response.output_text.delta","delta":"hi"}',
      'data: {"type":"response.reasoning_summary_text.delta","summary_index":0,"delta":"why"}',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"fc_1","name":"f"}}',
      'data: {"type":"response.function_call_arguments.delta","delta":"{\\"a\\":"}',
      'data: {"type":"response.function_call_arguments.done"}',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    ].join("\n");
    const completion = responsesStreamToCompletion(text, "gpt-5");
    const message = ((completion.choices as Json[])[0]!.message as Json);
    assert.equal(message.content, "hi");
    assert.equal(message.reasoning_content, "why");
    assert.equal(((message.tool_calls as Json[])[0]!.function as Json).arguments, '{"a":');
  });

  it("handles reasoning variants and custom tool input", () => {
    const text = [
      'data: {"type":"response.reasoning_text.done","content_index":0,"text":"r1"}',
      'data: {"type":"response.reasoning_summary_text.done","summary_index":0,"text":"s1"}',
      'data: {"type":"response.reasoning_summary_part.done","summary_index":1,"part":{"text":"s2"}}',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_2","call_id":"fc_2","name":"g"}}',
      'data: {"type":"response.custom_tool_call_input.delta","delta":"{}"}',
      'data: {"type":"response.output_item.done"}',
      'data: {"type":"response.completed","response":{"status":"completed"}}',
    ].join("\n");
    const completion = responsesStreamToCompletion(text, "gpt-5");
    const message = ((completion.choices as Json[])[0]!.message as Json);
    assert.equal(message.reasoning_content, "r1\n\ns1\n\ns2");
    assert.equal(((message.tool_calls as Json[])[0]!.function as Json).name, "g");
  });

  it("handles reasoning items and empty streams", () => {
    const text = 'data: {"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"text":"s"}]}}';
    const completion = responsesStreamToCompletion(text, "gpt-5");
    const message = ((completion.choices as Json[])[0]!.message as Json);
    assert.equal(message.reasoning_content, "s");

    const empty = responsesStreamToCompletion("", "gpt-5");
    assert.equal(((empty.choices as Json[])[0]!.message as Json).content, null);
  });
});
