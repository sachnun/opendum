import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import { WorkbuddyProvider, workbuddyStreamToCompletion } from "#providers/providers/workbuddy/provider.ts";
import { createTransport } from "#providers/api/http.ts";
import type { FetchLike } from "#providers/api/http.ts";
import type { ProviderAccount, ProviderRequest } from "#providers/model/types.ts";

type Json = Record<string, unknown>;

function registry(): Registry {
  return { upstreamModelName: (model: string) => model } as unknown as Registry;
}

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id: "a1", userId: "u1", provider: "workbuddy", accountId: "u1", ...overrides };
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

describe("WorkbuddyProvider credentials", () => {
  it("refreshes credentials", async () => {
    const { fetch } = recorder(json({ code: 0, data: { accessToken: "at", refreshToken: "rt2", expiresIn: 100 } }));
    const refreshed = await new WorkbuddyProvider({ registry: registry(), transport: createTransport(fetch) }).refreshCredentials("rt1", account());
    assert.equal(refreshed.accessToken, "at");
    assert.equal(refreshed.refreshToken, "rt2");
    assert.ok(refreshed.expiresAt.getTime() > Date.now());

    const absolute = new WorkbuddyProvider({
      registry: registry(),
      transport: createTransport(async () => json({ code: 0, data: { accessToken: "at", expiresAt: 2000000000 } })),
    });
    assert.equal((await absolute.refreshCredentials("rt", account())).expiresAt.getTime(), 2000000000000);
  });

  it("rejects failed refreshes", async () => {
    await assert.rejects(
      new WorkbuddyProvider({ registry: registry(), transport: createTransport(async () => json({}, 500)) }).refreshCredentials("rt", account()),
      /token refresh failed/
    );
    await assert.rejects(
      new WorkbuddyProvider({ registry: registry(), transport: createTransport(async () => json({ code: 1, data: {} })) }).refreshCredentials("rt", account()),
      /empty token/
    );
  });
});

describe("WorkbuddyProvider.makeRequest", () => {
  const sse = 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n';

  it("requires a user id", async () => {
    const provider = new WorkbuddyProvider({ registry: registry(), transport: createTransport(async () => json({})) });
    await assert.rejects(provider.makeRequest({ ...request({ model: "m" }), account: account({ accountId: null }) }), /missing user id/);
  });

  it("converts non-streaming completions", async () => {
    const { calls, fetch } = recorder(new Response(sse, { status: 200 }));
    const resp = await new WorkbuddyProvider({ registry: registry(), transport: createTransport(fetch) }).makeRequest(
      request({ model: "workbuddy/gpt-x", messages: [{ role: "developer", content: "d" }, { role: "user", content: "hi" }], max_tokens: 5 })
    );
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as Json;
    assert.equal(((body.choices as Json[])[0]!.message as Json).content, "hi");
    const sent = JSON.parse(calls[0]!.init!.body as string) as Json;
    assert.equal(sent.model, "gpt-x");
    assert.equal(sent.max_tokens, 5);
    assert.deepEqual(sent.messages, [{ role: "system", content: "d" }, { role: "user", content: "hi" }]);
    const headers = calls[0]!.init!.headers as Record<string, string>;
    assert.equal(headers["X-User-Id"], "u1");
    assert.equal(headers.Authorization, "Bearer tok");
  });

  it("prepends a default system message and max tokens", async () => {
    const { calls, fetch } = recorder(new Response(sse, { status: 200 }));
    await new WorkbuddyProvider({ registry: registry(), transport: createTransport(fetch) }).makeRequest(
      request({ model: "m", messages: [{ role: "user", content: "hi" }] })
    );
    const sent = JSON.parse(calls[0]!.init!.body as string) as Json;
    assert.equal((sent.messages as Json[])[0]!.role, "system");
    assert.equal(sent.max_tokens, 32768);
  });

  it("returns upstream errors", async () => {
    const provider = new WorkbuddyProvider({ registry: registry(), transport: createTransport(async () => json({}, 500)) });
    assert.equal((await provider.makeRequest(request({ model: "m", messages: [] }))).status, 500);
  });
});

describe("workbuddyStreamToCompletion", () => {
  it("aggregates content, tools and usage", () => {
    const text = [
      'data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      'data: {"choices":[{"delta":{"content":[{"text":"hello "},{"content":"world"}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"why"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","type":"function","function":{"name":"f","arguments":"{\\"a\\":"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ].join("\n");
    const completion = workbuddyStreamToCompletion(text, "m");
    const choice = (completion.choices as Json[])[0]!;
    const message = choice.message as Json;
    assert.equal(message.content, "hello worldwhy");
    assert.deepEqual(message.tool_calls, [{ id: "t1", type: "function", function: { name: "f", arguments: '{"a":1}' } }]);
    assert.equal(choice.finish_reason, "tool_calls");
    assert.deepEqual(completion.usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  });

  it("handles empty streams", () => {
    const completion = workbuddyStreamToCompletion("", "m");
    assert.equal(((completion.choices as Json[])[0]!.message as Json).content, "");
    assert.equal((completion.choices as Json[])[0]!.finish_reason, "stop");
  });
});
