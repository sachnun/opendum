import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import { PerchProvider, defaultPerchValue, perchNumber } from "#providers/providers/perch/provider.ts";
import { createTransport } from "#providers/api/http.ts";
import type { FetchLike } from "#providers/api/http.ts";
import type { ProviderAccount, ProviderRequest } from "#providers/model/types.ts";

type Json = Record<string, unknown>;

function registry(): Registry {
  return {
    upstreamModelName: (model: string) => model,
    modelsForProvider: () => ["qwen-3.6", "kimi-2.5"],
  } as unknown as Registry;
}

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id: "a1", userId: "u1", provider: "perch", ...overrides };
}

function request(body: Json, credentials = "tok", stream = false): ProviderRequest {
  return { account: account(), credentials, body, stream };
}

function routed(routes: Array<[string, () => Response]>): { calls: Array<{ url: string; init?: RequestInit }>; fetch: FetchLike } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      for (const [fragment, fn] of routes) {
        if (url.includes(fragment)) return fn();
      }
      return new Response("{}", { status: 404 });
    },
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const ticketRoute: [string, () => Response] = ["turn-ticket", () => json({ ok: true, ticket: "t1", runId: "r1" })];
const modelCallSse = 'data: {"type":"answer_delta","text":"hi"}\ndata: {"type":"done","ok":true}\n';

describe("PerchProvider credentials", () => {
  it("exposes the refresh buffer", () => {
    assert.equal(new PerchProvider({ registry: registry(), transport: createTransport(async () => json({})) }).refreshBuffer(), 5 * 60 * 1000);
  });

  it("reports auth config failures", async () => {
    const provider = new PerchProvider({ registry: registry(), transport: createTransport(async () => json({}, 500)) });
    await assert.rejects(provider.refreshCredentials("rt", account()), /auth config request failed/);

    const incomplete = new PerchProvider({ registry: registry(), transport: createTransport(async () => json({ supabaseUrl: "x" })) });
    await assert.rejects(incomplete.refreshCredentials("rt", account()), /incomplete/);
  });

  it("refreshes credentials", async () => {
    const { fetch } = routed([
      ["cli-auth/config", () => json({ supabaseUrl: "https://sb.example/", supabaseAnonKey: "key" })],
      ["grant_type=refresh_token", () => json({ access_token: "at", refresh_token: "rt2", expires_at: 2000000000 })],
    ]);
    const provider = new PerchProvider({ registry: registry(), transport: createTransport(fetch) });
    const refreshed = await provider.refreshCredentials("rt1", account());
    assert.equal(refreshed.accessToken, "at");
    assert.equal(refreshed.refreshToken, "rt2");
    assert.equal(refreshed.expiresAt.getTime(), 2000000000000);
  });

  it("rejects failed refreshes", async () => {
    const { fetch } = routed([
      ["cli-auth/config", () => json({ supabaseUrl: "https://sb.example", supabaseAnonKey: "key" })],
      ["grant_type=refresh_token", () => json({}, 400)],
    ]);
    await assert.rejects(new PerchProvider({ registry: registry(), transport: createTransport(fetch) }).refreshCredentials("rt", account()), /token refresh failed/);

    const { fetch: emptyFetch } = routed([
      ["grant_type=refresh_token", () => json({ access_token: "" })],
    ]);
    await assert.rejects(new PerchProvider({ registry: registry(), transport: createTransport(emptyFetch) }).refreshCredentials("rt", account()), /empty access token/);
  });
});

describe("PerchProvider.makeRequest", () => {
  it("rejects unsupported models", async () => {
    const provider = new PerchProvider({ registry: registry(), transport: createTransport(async () => json({})) });
    const resp = await provider.makeRequest(request({ model: "nope" }));
    assert.equal(resp.status, 400);
    assert.equal((((await resp.json()) as Json).error as Json).code, "unsupported_perch_model");
  });

  it("posts model calls with attribution", async () => {
    const { calls, fetch } = routed([
      ticketRoute,
      ["api/perchai/account", () => json({ ok: true, session: { userId: "u2", workspaceId: "w2" } })],
      ["model-call", () => new Response(modelCallSse, { status: 200 })],
    ]);
    const provider = new PerchProvider({ registry: registry(), transport: createTransport(fetch) });
    const resp = await provider.makeRequest(
      request({
        model: "perch/qwen-3.6",
        system: "sys",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "", tool_calls: [{ id: "t1", function: { name: "f", arguments: "" } }] },
          { role: "tool", tool_call_id: "t1", content: "r" },
        ],
        tools: [{ function: { name: "f", description: "d", parameters: {} } }],
        temperature: 0.2,
        max_tokens: 10,
        reasoning_effort: "low",
      })
    );
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as Json;
    assert.equal((((body.choices as Json[])[0]!.message as Json)).content, "hi");
    const modelCall = calls.find((call) => call.url.includes("model-call"))!;
    const payload = JSON.parse(modelCall.init!.body as string) as Json;
    assert.equal(payload.manualModelOptionId, "wandb-qwen3-6-35b-a3b");
    assert.equal((payload.effort as Json).level, "low");
    assert.equal((payload.attribution as Json).workspaceId, "w2");
  });

  it("streams and handles missing attribution", async () => {
    const { fetch } = routed([
      ticketRoute,
      ["api/perchai/account", () => json({}, 500)],
      ["model-call", () => new Response(streamOf([modelCallSse]), { status: 200 })],
    ]);
    const provider = new PerchProvider({ registry: registry(), transport: createTransport(fetch) });
    const resp = await provider.makeRequest(request({ model: "qwen-3.6", messages: [] }, "tok", true));
    assert.equal(resp.headers.get("content-type"), "text/event-stream");
    assert.match(await resp.text(), /"content":"hi"/);
  });

  it("maps upstream failures", async () => {
    const errorProvider = (status: number, body: string) =>
      new PerchProvider({
        registry: registry(),
        transport: createTransport(
          routed([ticketRoute, ["model-call", () => new Response(body, { status })]]).fetch
        ),
      });
    assert.equal((await errorProvider(500, "").makeRequest(request({ model: "qwen-3.6", messages: [] }))).status, 500);

    const quota = errorProvider(200, 'data: {"type":"done","ok":false,"error":"usage limit reached"}\n');
    assert.equal((await quota.makeRequest(request({ model: "qwen-3.6", messages: [] }))).status, 429);

    const failure = errorProvider(200, 'data: {"type":"done","ok":false,"error":"boom"}\n');
    assert.equal((await failure.makeRequest(request({ model: "qwen-3.6", messages: [] }))).status, 502);
  });

  it("exposes small helpers", () => {
    assert.equal(defaultPerchValue("", "fb"), "fb");
    assert.equal(perchNumber("3"), 3);
  });
});
