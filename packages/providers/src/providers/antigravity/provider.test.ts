import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import { AntigravityProvider } from "#providers/providers/antigravity/provider.ts";
import { createTransport } from "#providers/api/http.ts";
import type { FetchLike } from "#providers/api/http.ts";
import type { ProviderAccount, ProviderRequest } from "#providers/model/types.ts";

type Json = Record<string, unknown>;

function registry(configs: Record<string, Json> = {}): Registry {
  return {
    upstreamModelName: (model: string) => model,
    isReasoningModel: () => false,
    isSupportedByProvider: () => false,
    providerModelConfig: (model: string) => configs[model] ?? null,
  } as unknown as Registry;
}

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id: "a1", userId: "u1", provider: "antigravity", projectId: "p1", ...overrides };
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

const geminiSse = [
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}',
  'data: {"response":{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}}',
].join("\n\n");

describe("AntigravityProvider credentials", () => {
  it("exposes the refresh buffer", () => {
    assert.equal(
      new AntigravityProvider({ registry: registry(), transport: createTransport(async () => json({})) }).refreshBuffer(),
      60 * 60 * 1000
    );
  });

  it("refreshes credentials and reads account info", async () => {
    const { fetch } = routed([
      ["oauth2.googleapis.com", () => json({ access_token: "at", refresh_token: "rt2", expires_in: 120 })],
      ["loadCodeAssist", () => json({ cloudaicompanionProject: "proj", currentTier: { id: "free-tier" } })],
      ["userinfo", () => json({ email: "a@b.c" })],
    ]);
    const provider = new AntigravityProvider({ registry: registry(), transport: createTransport(fetch) });
    const refreshed = await provider.refreshCredentials("rt1", account());
    assert.equal(refreshed.accessToken, "at");
    assert.equal(refreshed.refreshToken, "rt2");
    assert.equal(refreshed.projectId, "proj");
    assert.equal(refreshed.email, "a@b.c");
  });

  it("rejects failed refreshes", async () => {
    await assert.rejects(
      new AntigravityProvider({ registry: registry(), transport: createTransport(async () => json({}, 400)) }).refreshCredentials("rt", account()),
      /token refresh failed/
    );
    await assert.rejects(
      new AntigravityProvider({ registry: registry(), transport: createTransport(async () => json({})) }).refreshCredentials("rt", account()),
      /empty access token/
    );
  });
});

describe("AntigravityProvider.makeRequest", () => {
  it("converts a streamed gemini response", async () => {
    const { calls, fetch } = routed([["GenerateContent", () => new Response(streamOf([geminiSse]), { status: 200 })]]);
    const provider = new AntigravityProvider({ registry: registry(), transport: createTransport(fetch) });
    const resp = await provider.makeRequest(request({ model: "claude-sonnet", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as Json;
    assert.equal(((body.choices as Json[])[0]!.message as Json).content, "hi");
    assert.equal(calls[0]!.url.includes("streamGenerateContent"), true);
    assert.equal((calls[0]!.init!.headers as Record<string, string>)["anthropic-beta"] !== undefined, true);
  });

  it("returns rate limits immediately", async () => {
    const provider = new AntigravityProvider({
      registry: registry(),
      transport: createTransport(async () => new Response(null, { status: 429 })),
    });
    assert.equal((await provider.makeRequest(request({ model: "gemini-2-flash", messages: [] }))).status, 429);
  });

  it("returns the last upstream error", async () => {
    const provider = new AntigravityProvider({
      registry: registry(),
      transport: createTransport(async () => new Response("bad", { status: 500 })),
    });
    assert.equal((await provider.makeRequest(request({ model: "gemini-2-flash", messages: [] }))).status, 500);
  });

  it("returns retired responses", async () => {
    const retired = streamOf(['data: {"response":{"candidates":[{"content":{"parts":[{"text":"Gemini X is no longer available. Please switch to Y"}]}}]}}\n\n']);
    const provider = new AntigravityProvider({
      registry: registry(),
      transport: createTransport(async () => new Response(retired, { status: 200 })),
    });
    const resp = await provider.makeRequest(request({ model: "claude-sonnet", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(resp.status, 404);
  });
});
