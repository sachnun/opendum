import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import { KiroProvider } from "#providers/providers/kiro/provider.ts";
import { createTransport } from "#providers/api/http.ts";
import type { FetchLike } from "#providers/api/http.ts";
import type { ProviderAccount, ProviderRequest } from "#providers/model/types.ts";

type Json = Record<string, unknown>;

function registry(): Registry {
  return {
    isSupportedByProvider: () => false,
    upstreamModelName: (model: string) => model,
    isReasoningModel: () => false,
  } as unknown as Registry;
}

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id: "a1", userId: "u1", provider: "kiro", ...overrides };
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

describe("KiroProvider credentials", () => {
  it("exposes the refresh buffer", () => {
    assert.equal(new KiroProvider({ registry: registry(), transport: createTransport(async () => json({})) }).refreshBuffer(), 5 * 60 * 1000);
  });

  it("refreshes credentials and reads the subscription tier", async () => {
    const { fetch } = routed([
      ["refreshToken", () => json({ accessToken: "at", refreshToken: "rt2", expiresIn: 100 })],
      ["amazonaws.com", () => json({ data: { subscriptionInfo: { type: "Q_DEVELOPER_STANDALONE_PRO" } } })],
    ]);
    const refreshed = await new KiroProvider({ registry: registry(), transport: createTransport(fetch) }).refreshCredentials("rt1", account());
    assert.equal(refreshed.accessToken, "at");
    assert.equal(refreshed.refreshToken, "rt2");
    assert.equal(refreshed.tier, "pro");
  });

  it("keeps refreshing when the tier lookup fails", async () => {
    const { fetch } = routed([
      ["refreshToken", () => json({ accessToken: "at" })],
      ["amazonaws.com", () => json({}, 500)],
    ]);
    const refreshed = await new KiroProvider({ registry: registry(), transport: createTransport(fetch) }).refreshCredentials("rt", account());
    assert.equal(refreshed.tier, "");
  });

  it("rejects failed refreshes", async () => {
    await assert.rejects(
      new KiroProvider({ registry: registry(), transport: createTransport(async () => json({}, 400)) }).refreshCredentials("rt", account()),
      /token refresh failed/
    );
    await assert.rejects(
      new KiroProvider({ registry: registry(), transport: createTransport(async () => json({ accessToken: "" })) }).refreshCredentials("rt", account()),
      /empty access token/
    );
  });
});

describe("KiroProvider.makeRequest", () => {
  it("builds non-streaming completions", async () => {
    const { calls, fetch } = routed([["amazonaws.com", () => new Response('{"content":"hi"}{"stop":true}', { status: 200 })]]);
    const provider = new KiroProvider({ registry: registry(), transport: createTransport(fetch) });
    const resp = await provider.makeRequest(request({ model: "kiro/claude-x", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as Json;
    assert.equal(((body.choices as Json[])[0]!.message as Json).content, "hi");
    const payload = JSON.parse(calls[0]!.init!.body as string) as Json;
    assert.equal(calls[0]!.url.includes("amazonaws.com"), true);
    assert.equal("conversationState" in payload, true);
  });

  it("adds the profile arn and streams chunked output", async () => {
    const { calls, fetch } = routed([["amazonaws.com", () => new Response('{"content":"hi"}{"stop":true}', { status: 200 })]]);
    const provider = new KiroProvider({ registry: registry(), transport: createTransport(fetch) });
    const resp = await provider.makeRequest({
      ...request({ model: "claude-x", messages: [{ role: "user", content: "hi" }] }, "tok", true),
      account: account({ accountId: "arn:aws:codewhisperer:us-east-1:1:profile/x" }),
    });
    assert.equal(resp.headers.get("content-type"), "text/event-stream");
    await resp.text();
    const payload = JSON.parse(calls[0]!.init!.body as string) as Json;
    assert.equal(payload.profileArn, "arn:aws:codewhisperer:us-east-1:1:profile/x");
  });

  it("streams tool calls and bracket calls", async () => {
    const raw = [
      JSON.stringify({ name: "lookup", toolUseId: "t1", input: '{"q":' }),
      JSON.stringify({ input: '"x"}' }),
      JSON.stringify({ stop: true }),
      JSON.stringify({ content: "done [Called f with args: {\"a\":1}]" }),
    ].join("");
    const { fetch } = routed([["amazonaws.com", () => new Response(raw, { status: 200 })]]);
    const provider = new KiroProvider({ registry: registry(), transport: createTransport(fetch) });
    const resp = await provider.makeRequest(request({ model: "claude-x", messages: [] }, "tok", true));
    const text = await resp.text();
    assert.match(text, /lookup/);
    assert.match(text, /"name":"f"/);
    assert.match(text, /data: \[DONE\]/);
  });

  it("returns upstream errors and empty streams", async () => {
    const errorProvider = new KiroProvider({
      registry: registry(),
      transport: createTransport(async () => new Response("bad", { status: 500 })),
    });
    assert.equal((await errorProvider.makeRequest(request({ model: "m", messages: [] }))).status, 500);

    const emptyProvider = new KiroProvider({
      registry: registry(),
      transport: createTransport(async () => new Response(null, { status: 200 })),
    });
    assert.equal((await emptyProvider.makeRequest(request({ model: "m", messages: [] }))).status, 502);
  });
});
