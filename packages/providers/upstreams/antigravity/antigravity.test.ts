import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Registry } from "@opendum/models/runtime";

import { AntigravityProvider } from "./index.js";
import { peekRetiredNotice } from "./transform.js";

const STREAM = [
  'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}]}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const RETIRED_STREAM = [
  'data: {"candidates":[{"content":{"parts":[{"text":"gemini-2.5-flash is no longer available. Please switch to a newer model."}]}}]}',
  "",
  "data: [DONE]",
  "",
].join("\n");

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

function stubTransport(body: string, onBody?: (value: string) => void) {
  return {
    direct: async (_url: string, init?: RequestInit) => {
      onBody?.(String(init?.body ?? ""));
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  };
}

function antigravityProvider(transport: unknown): AntigravityProvider {
  const registry = {
    config: () => null,
    upstream: (model: string) => model,
  };
  return new AntigravityProvider({
    registry: registry as unknown as Registry,
    transport: transport as never,
    redis: null,
  });
}

describe("antigravity retired notice", () => {
  it("preserves the response stream when no notice is found", async () => {
    const peeked = await peekRetiredNotice(new Response(STREAM, { status: 200 }));
    expect(peeked.retired).toBe(false);
    expect(peeked.body).toBeTruthy();
    if (!peeked.body) return;
    expect(await readAll(peeked.body)).toBe(STREAM);
  });

  it("detects a retired notice without passing the stream through", async () => {
    const peeked = await peekRetiredNotice(new Response(RETIRED_STREAM, { status: 200 }));
    expect(peeked.retired).toBe(true);
    expect(peeked.body).toBe(null);
    expect(peeked.notice ?? "").toMatch(/no longer available/);
  });
});

describe("antigravity makeRequest", () => {
  it("streams the upstream content to the client", async () => {
    const provider = antigravityProvider(stubTransport(STREAM));
    const resp = await Effect.runPromise(
      provider.makeRequest({
        account: { id: "a", userId: "u", provider: "antigravity", projectId: "proj" },
        credentials: "token",
        body: { model: "gemini-3.5-flash-medium", messages: [{ role: "user", content: "hi" }] },
        stream: true,
      })
    );
    const text = await resp.text();
    expect(text).toMatch(/hello/);
    expect(text).toMatch(/data: \[DONE\]/);
  });

  it("injects the antigravity system instruction from the model family", async () => {
    let sent = "";
    const provider = antigravityProvider(stubTransport(STREAM, (value) => (sent = value)));
    await Effect.runPromise(
      provider.makeRequest({
        account: { id: "a", userId: "u", provider: "antigravity", projectId: "proj" },
        credentials: "token",
        body: { model: "gemini-3.5-flash-medium", messages: [{ role: "user", content: "hi" }] },
        stream: true,
      })
    );
    const payload = JSON.parse(sent) as {
      request?: { systemInstruction?: { parts?: { text?: string }[] } };
    };
    const injected = payload.request?.systemInstruction?.parts?.some((part) =>
      (part.text ?? "").startsWith("You are Antigravity")
    );
    expect(injected).toBe(true);
  });
});
