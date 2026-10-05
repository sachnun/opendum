import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAICompatibleProvider } from "#providers/providers/openai-compatible.ts";
import { createTransport } from "#providers/api/http.ts";
import type { FetchLike } from "#providers/api/http.ts";
import type { ProviderAccount, ProviderRequest } from "#providers/model/types.ts";

type Json = Record<string, unknown>;

function jsonResponse(status: number, payload: unknown): Response {
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

function account(): ProviderAccount {
  return { id: "a1", userId: "u1", provider: "test" };
}

function request(body: Json, stream = false, credentials = "tok"): ProviderRequest {
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

function provider(options: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    name: "test",
    baseUrl: "https://api",
    supportedParams: new Set(["model", "messages", "temperature", "top_p", "max_tokens", "stream"]),
    registry: null,
    transport: createTransport(async () => new Response("{}")),
    fallback: null,
    ...options,
  });
}

describe("OpenAICompatibleProvider.makeRequest", () => {
  it("posts chat completions with auth", async () => {
    const { calls, fetch } = recorder(jsonResponse(200, { choices: [] }));
    await provider({ transport: createTransport(fetch) }).makeRequest(request({ model: "m", messages: [], stream: false }));
    assert.equal(calls[0]!.url, "https://api/chat/completions");
    assert.equal(calls[0]!.init!.method, "POST");
    assert.equal((calls[0]!.init!.headers as Record<string, string>).Authorization, "Bearer tok");
    const body = JSON.parse(calls[0]!.init!.body as string) as Json;
    assert.equal(body.model, "m");
    assert.equal(body.stream, false);
  });

  it("trims prefixes and resolves upstream names", async () => {
    const { calls, fetch } = recorder(jsonResponse(200, {}));
    await provider({
      trimPrefix: "custom/",
      upstreamName: (model) => `up-${model}`,
      transport: createTransport(fetch),
    }).makeRequest(request({ model: "custom/m" }));
    const body = JSON.parse(calls[0]!.init!.body as string) as Json;
    assert.equal(body.model, "up-m");
  });

  it("drops deprecated top_p and filters unsupported params", async () => {
    const { calls, fetch } = recorder(jsonResponse(200, {}));
    await provider({
      modelFlags: () => ({ top_p_deprecated: true }),
      transport: createTransport(fetch),
    }).makeRequest(request({ model: "m", temperature: 0.5, top_p: 0.5, unknown: 1 }));
    const body = JSON.parse(calls[0]!.init!.body as string) as Json;
    assert.equal(body.temperature, 0.5);
    assert.equal("top_p" in body, false);
    assert.equal("unknown" in body, false);
  });

  it("omits auth for authless models", async () => {
    const { calls, fetch } = recorder(jsonResponse(200, {}));
    await provider({ isAuthless: () => true, transport: createTransport(fetch) }).makeRequest(request({ model: "m" }, false, ""));
    assert.equal("Authorization" in (calls[0]!.init!.headers as Record<string, string>), false);
  });

  it("adds provider-specific and extra headers", async () => {
    const { calls, fetch } = recorder(jsonResponse(200, {}));
    await provider({ name: "zenmux", extraHeaders: { "X-Extra": "1" }, transport: createTransport(fetch) }).makeRequest(
      request({ model: "m" })
    );
    const headers = calls[0]!.init!.headers as Record<string, string>;
    assert.equal(headers["x-zenmux-apikey-source"], "subscription");
    assert.equal(headers["X-Extra"], "1");
  });

  it("converts external images when flagged", async () => {
    const { calls, fetch } = recorder(jsonResponse(200, {}));
    await provider({ modelFlags: () => ({ convert_external_images: true }), transport: createTransport(fetch) }).makeRequest(
      request({ model: "m", messages: [{ role: "user", content: "hi" }] })
    );
    const body = JSON.parse(calls[0]!.init!.body as string) as Json;
    assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
  });
});

describe("OpenAICompatibleProvider responses API", () => {
  it("converts non-streaming responses to chat completions", async () => {
    const fetch = async () =>
      jsonResponse(200, { output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }], status: "completed" });
    const resp = await provider({ modelFlags: () => ({ responses_api: true }), transport: createTransport(fetch) }).makeRequest(
      request({ model: "m", messages: [{ role: "user", content: "hi" }] })
    );
    const json = (await resp.json()) as Json;
    assert.equal((((json.choices as Json[])[0]!.message as Json).content), "hi");
  });

  it("passes through native responses input", async () => {
    const native = jsonResponse(200, { id: "r1" });
    let seenUrl = "";
    const fetch: FetchLike = async (url) => {
      seenUrl = url;
      return native;
    };
    const resp = await provider({ modelFlags: () => ({ responses_api: true }), transport: createTransport(fetch) }).makeRequest(
      request({ model: "m", _responsesInput: [] })
    );
    assert.equal(resp, native);
    assert.equal(seenUrl, "https://api/responses");
  });

  it("streams converted responses", async () => {
    const fetch = async () =>
      new Response(streamOf(['data: {"type":"response.output_text.delta","delta":"hi"}\n\ndata: [DONE]\n']), { status: 200 });
    const resp = await provider({ modelFlags: () => ({ responses_api: true }), transport: createTransport(fetch) }).makeRequest(
      request({ model: "m", messages: [{ role: "user", content: "hi" }] }, true)
    );
    assert.equal(resp.headers.get("content-type"), "text/event-stream");
    await resp.text();
  });

  it("reports responses native models", () => {
    const p = provider({ modelFlags: (model) => ({ responses_api: model === "m" }) });
    assert.equal(p.responsesNative("m"), true);
    assert.equal(p.responsesNative("other"), false);
  });
});

describe("OpenAICompatibleProvider egress fallback", () => {
  it("escalates to egress after a direct fallback status", async () => {
    const direct = recorder(new Response(null, { status: 429 }));
    const egress = recorder(jsonResponse(200, {}));
    const transport = createTransport(direct.fetch);
    transport.setEgress(egress.fetch, true);
    const resp = await provider({ transport }).makeRequest(request({ model: "m" }));
    assert.equal(resp.status, 200);
    assert.equal(direct.calls.length, 1);
    assert.equal(egress.calls.length, 1);
  });
});
