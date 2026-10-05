import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileCustomProvider } from "#providers/providers/custom.ts";
import { createTransport } from "#providers/api/http.ts";
import type { FetchLike } from "#providers/api/http.ts";
import type { ProviderRequest } from "#providers/model/types.ts";

type Json = Record<string, unknown>;

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

function request(body: Json, credentials = "tok", stream = false): ProviderRequest {
  return { account: { id: "a", userId: "u", provider: "custom" }, credentials, body, stream };
}

const models = [
  { modelId: "m1", upstream: " upstream-1 ", authless: false, customFlags: null },
  { modelId: "m2", upstream: null, authless: true, customFlags: { responses_api: true } },
  { modelId: "m3", upstream: null, authless: false, customFlags: { top_p_deprecated: true, convert_external_images: true, responses_api: false } },
];

describe("compileCustomProvider", () => {
  it("resolves upstream names and flags", async () => {
    const { calls, fetch } = recorder(new Response("{}", { status: 200 }));
    const provider = compileCustomProvider({
      provider: { slug: "custom", baseUrl: "https://api", extraHeaders: { "X-H": "1" } },
      models,
      transport: createTransport(fetch),
      fallback: null,
    });
    assert.equal(provider.name, "custom");

    await provider.makeRequest(request({ model: "custom/m1", messages: [] }));
    const body = JSON.parse(calls[0]!.init!.body as string) as Json;
    assert.equal(body.model, "upstream-1");
    assert.equal(calls[0]!.url, "https://api/chat/completions");
    assert.equal((calls[0]!.init!.headers as Record<string, string>)["X-H"], "1");
  });

  it("routes responses-enabled models and skips auth for authless models", async () => {
    const responses = recorder(new Response(JSON.stringify({ output: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = compileCustomProvider({
      provider: { slug: "custom", baseUrl: "https://api", extraHeaders: null },
      models,
      transport: createTransport(responses.fetch),
      fallback: null,
    });
    await provider.makeRequest(request({ model: "custom/m2", messages: [{ role: "user", content: "hi" }] }, ""));
    assert.equal(responses.calls[0]!.url, "https://api/responses");
    assert.equal("Authorization" in (responses.calls[0]!.init!.headers as Record<string, string>), false);
  });

  it("handles unconfigured models", async () => {
    const { calls, fetch } = recorder(new Response("{}", { status: 200 }));
    const provider = compileCustomProvider({
      provider: { slug: "custom", baseUrl: "https://api", extraHeaders: null },
      models,
      transport: createTransport(fetch),
      fallback: null,
    });
    await provider.makeRequest(request({ model: "custom/unknown", messages: [] }));
    const body = JSON.parse(calls[0]!.init!.body as string) as Json;
    assert.equal(body.model, "unknown");
  });
});
