import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import { OpencodeProvider, defaultOpencodeValue, opencodeFallbackUrls } from "#providers/providers/opencode/provider.ts";
import { createTransport } from "#providers/api/http.ts";
import type { FetchLike } from "#providers/api/http.ts";
import type { ProviderRequest } from "#providers/model/types.ts";

type Json = Record<string, unknown>;

function registry(config: Json = {}): Registry {
  return {
    upstreamModelName: (model: string) => model,
    providerModelConfig: () => config,
  } as unknown as Registry;
}

function request(body: Json, stream = false): ProviderRequest {
  return { account: { id: "a1", userId: "u1", provider: "opencode" }, credentials: "public", body, stream };
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

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const chatSse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\ndata: [DONE]\n';
const anthropicSse = [
  'data: {"type":"message_start","message":{"id":"m1"}}',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
  'data: {"type":"message_stop"}',
  "data: [DONE]",
].join("\n\n");

describe("OpencodeProvider chat path", () => {
  it("builds headers, fingerprints tools and converts non-streaming output", async () => {
    const { calls, fetch } = recorder(new Response(chatSse, { status: 200 }));
    const provider = new OpencodeProvider({ registry: registry(), transport: createTransport(fetch), fallback: null });
    const resp = await provider.makeRequest(request({ model: "opencode/x", messages: [], _sessionId: "seed", _requestId: "req" }));
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as Json;
    assert.equal(((body.choices as Json[])[0]!.message as Json).content, "hi");

    const headers = calls[0]!.init!.headers as Record<string, string>;
    assert.match(headers["X-Opencode-Session"]!, /^ses_/);
    assert.match(headers["X-Opencode-Request"]!, /^msg_/);
    assert.equal(headers["X-Opencode-Project"], "global");
    const sent = JSON.parse(calls[0]!.init!.body as string) as Json;
    assert.equal((sent.tools as unknown[]).length, 4);
    assert.equal(sent.model, "x");
  });

  it("streams when requested and preserves existing ids", async () => {
    const session = `ses_${"a".repeat(12)}${"B".repeat(14)}`;
    const req = `msg_${"c".repeat(12)}${"D".repeat(14)}`;
    const { calls, fetch } = recorder(new Response(streamOf([chatSse]), { status: 200 }));
    const provider = new OpencodeProvider({ registry: registry(), transport: createTransport(fetch), fallback: null });
    const resp = await provider.makeRequest(request({ model: "x", messages: [], _sessionId: session, _requestId: req }, true));
    assert.ok(calls.length >= 1);
    const headers = calls[0]!.init!.headers as Record<string, string>;
    assert.equal(headers["X-Opencode-Session"], session);
    assert.equal(headers["X-Opencode-Request"], req);
    await resp.text();
  });

  it("returns upstream errors", async () => {
    const provider = new OpencodeProvider({
      registry: registry(),
      transport: createTransport(async () => new Response("bad", { status: 500 })),
      fallback: null,
    });
    assert.equal((await provider.makeRequest(request({ model: "x", messages: [] }))).status, 500);
  });
});

describe("OpencodeProvider responses path", () => {
  const responsesSse = 'data: {"type":"response.output_text.delta","delta":"hi"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n';

  it("converts responses streams for chat clients", async () => {
    const { calls, fetch } = recorder(new Response(responsesSse, { status: 200 }));
    const provider = new OpencodeProvider({ registry: registry({ responses_api: true }), transport: createTransport(fetch), fallback: null });
    const resp = await provider.makeRequest(request({ model: "x", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(calls[0]!.url, "https://opencode.ai/zen/v1/responses");
    const body = (await resp.json()) as Json;
    assert.equal(((body.choices as Json[])[0]!.message as Json).content, "hi");
  });

  it("passes through native responses input", async () => {
    const { fetch } = recorder(new Response(responsesSse, { status: 200 }));
    const provider = new OpencodeProvider({ registry: registry({ responses_api: true }), transport: createTransport(fetch), fallback: null });
    const streamed = await provider.makeRequest(request({ model: "x", _responsesInput: [] }, true));
    assert.equal(streamed.status, 200);
    const json = await provider.makeRequest(request({ model: "x", _responsesInput: [] }, false));
    assert.equal(((await json.json()) as Json).status, "completed");
  });

  it("streams converted responses", async () => {
    const { fetch } = recorder(new Response(streamOf([responsesSse]), { status: 200 }));
    const provider = new OpencodeProvider({ registry: registry({ responses_api: true }), transport: createTransport(fetch), fallback: null });
    const resp = await provider.makeRequest(request({ model: "x", messages: [] }, true));
    assert.equal(resp.headers.get("content-type"), "text/event-stream");
    await resp.text();
  });

  it("reports responses-native models", () => {
    const provider = new OpencodeProvider({ registry: registry({ responses_api: true }), transport: createTransport(async () => new Response("{}")), fallback: null });
    assert.equal(provider.responsesNative("opencode/x"), true);
    assert.equal(new OpencodeProvider({ registry: registry(), transport: createTransport(async () => new Response("{}")), fallback: null }).responsesNative("x"), false);
  });
});

describe("OpencodeProvider messages path", () => {
  it("converts anthropic streams", async () => {
    const { calls, fetch } = recorder(new Response(anthropicSse, { status: 200 }));
    const provider = new OpencodeProvider({ registry: registry({ messages_api: true }), transport: createTransport(fetch), fallback: null });
    const resp = await provider.makeRequest(request({ model: "x", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(calls[0]!.url, "https://opencode.ai/zen/v1/messages");
    const body = (await resp.json()) as Json;
    assert.equal(((body.choices as Json[])[0]!.message as Json).content, "hi");
  });

  it("streams anthropic responses", async () => {
    const { fetch } = recorder(new Response(streamOf([anthropicSse]), { status: 200 }));
    const provider = new OpencodeProvider({ registry: registry({ messages_api: true }), transport: createTransport(fetch), fallback: null });
    const resp = await provider.makeRequest(request({ model: "x", messages: [] }, true));
    assert.equal(resp.headers.get("content-type"), "text/event-stream");
    await resp.text();
  });
});

describe("opencode helpers", () => {
  it("exposes fallback urls and defaults", () => {
    assert.match(opencodeFallbackUrls().chat, /unroxy/);
    assert.equal(defaultOpencodeValue("", "fb"), "fb");
    assert.equal(new OpencodeProvider({ registry: registry(), transport: createTransport(async () => new Response("{}")), fallback: null }).authless(), true);
  });
});
